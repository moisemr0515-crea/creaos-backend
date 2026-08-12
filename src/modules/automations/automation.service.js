const Automation    = require('./automation.model');
const AutomationLog = require('./automation-log.model');
const { runAutomation } = require('./automation.engine');
const Lead          = require('../leads/lead.model');
const subscriptionService = require('../subscriptions/subscription.service');
const { AppError }  = require('../../middleware/error.middleware');

// ─── Límite de plan (automatizaciones ACTIVAS simultáneas) ───────────────────

/**
 * Verifica (fail-closed) que activar una automatización no exceda
 * `Plan.limits.maxActiveAutomations` del negocio. `excludeAutomationId` se usa
 * al togglear/actualizar una automatización ya existente, para no contarla
 * dos veces contra sí misma. -1 en el límite significa "ilimitado" (mismo
 * convenio que subscriptionService#checkLeadLimit).
 */
const verificarLimiteAutomatizaciones = async (businessId, excludeAutomationId = null) => {
  const sub = await subscriptionService.getCurrentSubscription(businessId);
  const limite = sub.plan?.limits?.maxActiveAutomations ?? 0;

  if (limite === -1) return { limite, activas: null };

  const query = { business: businessId, isActive: true, isDeleted: false };
  if (excludeAutomationId) query._id = { $ne: excludeAutomationId };
  const activas = await Automation.countDocuments(query);

  if (activas >= limite) {
    const mensaje = limite === 0
      ? 'Tu plan actual no incluye automatizaciones activas. Actualiza tu plan para usar esta función.'
      : `Alcanzaste el límite de automatizaciones activas de tu plan (${limite}). Desactiva alguna para poder activar esta.`;
    throw new AppError(mensaje, 403);
  }

  return { limite, activas };
};

// ─── Seed lazy de las automatizaciones "de producto" ─────────────────────────

/**
 * Placeholder de las 2 automatizaciones fijas que controlan los toggles
 * "Seguimientos automáticos" / "Cierre automático" del frontend (business.tsx).
 * Quedan con trigger 'manual' + una acción inofensiva (add_note) porque el
 * motor de automatizaciones todavía no tiene un trigger basado en tiempo/
 * inactividad ("N días sin seguimiento") — ese trabajo queda para un ticket
 * separado. El alcance de este fix es el límite de plan sobre el toggle, no
 * la lógica de negocio de qué hace la automatización al dispararse.
 */
const AUTOMATIZACIONES_SEMILLA = [
  {
    type: 'followup',
    name: 'Seguimientos automáticos',
    description:
      'Placeholder — la lógica real de "leads sin seguimiento hace N días" necesita un trigger por tiempo que aún no existe en el motor. Actívala cuando esa pieza esté lista.',
    trigger: { type: 'manual', conditions: [] },
    actions: [{ order: 1, type: 'add_note', config: { content: 'Seguimiento automático (placeholder)' }, delay: 0 }],
  },
  {
    type: 'auto_close',
    name: 'Cierre automático',
    description:
      'Placeholder — la lógica real de cierre automático de oportunidades avanzadas necesita un trigger por tiempo/probabilidad que aún no existe en el motor.',
    trigger: { type: 'manual', conditions: [] },
    actions: [{ order: 1, type: 'add_note', config: { content: 'Cierre automático (placeholder)' }, delay: 0 }],
  },
];

/**
 * Crea las automatizaciones semilla si el negocio todavía no las tiene
 * (idempotente vía upsert + $setOnInsert — no pisa nombre/descripción si el
 * usuario ya las editó). Se llama de forma lazy desde listAutomations() y
 * obtenerEstadoAutomatizaciones(), no desde el registro del negocio.
 */
const asegurarAutomatizacionesSemilla = async (businessId, userId) => {
  await Promise.all(
    AUTOMATIZACIONES_SEMILLA.map((semilla) =>
      Automation.findOneAndUpdate(
        { business: businessId, type: semilla.type },
        {
          $setOnInsert: {
            business: businessId,
            createdBy: userId,
            name: semilla.name,
            description: semilla.description,
            type: semilla.type,
            trigger: semilla.trigger,
            actions: semilla.actions,
            isActive: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
    )
  );
};

// ─── 1. createAutomation ─────────────────────────────────────────────────────

const createAutomation = async (businessId, data, userId) => {
  const isActive = data.isActive ?? true;
  if (isActive) await verificarLimiteAutomatizaciones(businessId);

  const automation = await Automation.create({
    business:  businessId,
    createdBy: userId,
    name:      data.name,
    description: data.description,
    trigger:   data.trigger,
    actions:   data.actions,
    isActive,
  });
  return automation;
};

// ─── 2. listAutomations ───────────────────────────────────────────────────────

const listAutomations = async (businessId, filters = {}, userId) => {
  await asegurarAutomatizacionesSemilla(businessId, userId);

  const { isActive, triggerType, page = 1, limit = 20 } = filters;
  const skip = (Number(page) - 1) * Number(limit);

  const query = { business: businessId, isDeleted: false };
  if (isActive !== undefined) query.isActive = isActive === 'true' || isActive === true;
  if (triggerType) query['trigger.type'] = triggerType;

  const [automations, total] = await Promise.all([
    Automation.find(query)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Automation.countDocuments(query),
  ]);

  return { automations, total };
};

// ─── 3. getAutomationById ─────────────────────────────────────────────────────

const getAutomationById = async (businessId, automationId) => {
  const automation = await Automation.findOne({
    _id: automationId,
    business: businessId,
    isDeleted: false,
  }).populate('createdBy', 'name email');
  if (!automation) throw new AppError('Automatización no encontrada', 404);
  return automation;
};

// ─── 4. updateAutomation ─────────────────────────────────────────────────────

const updateAutomation = async (businessId, automationId, data) => {
  const allowed = ['name', 'description', 'trigger', 'actions', 'isActive'];
  const updates = {};
  for (const key of allowed) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (!Object.keys(updates).length) throw new AppError('No hay campos para actualizar', 400);

  const automation = await Automation.findOne({ _id: automationId, business: businessId, isDeleted: false });
  if (!automation) throw new AppError('Automatización no encontrada', 404);

  // Solo valida el límite si este update ENCIENDE la automatización (pasa de
  // inactiva a activa) — un update que la deja igual o la apaga nunca debe
  // bloquearse por el límite de plan.
  if (updates.isActive === true && !automation.isActive) {
    await verificarLimiteAutomatizaciones(businessId, automationId);
  }

  Object.assign(automation, updates);
  await automation.save();
  return automation;
};

// ─── 5. deleteAutomation (soft) ───────────────────────────────────────────────

const deleteAutomation = async (businessId, automationId) => {
  const automation = await Automation.findOneAndUpdate(
    { _id: automationId, business: businessId, isDeleted: false },
    { $set: { isDeleted: true, isActive: false } },
    { new: true }
  );
  if (!automation) throw new AppError('Automatización no encontrada', 404);
};

// ─── 6. toggleActive ─────────────────────────────────────────────────────────

const toggleActive = async (businessId, automationId) => {
  const automation = await Automation.findOne({ _id: automationId, business: businessId, isDeleted: false });
  if (!automation) throw new AppError('Automatización no encontrada', 404);

  const activando = !automation.isActive;
  // Fail-closed: solo se valida contra el límite de plan cuando se está
  // ENCENDIENDO (false→true) — apagar siempre está permitido.
  if (activando) {
    await verificarLimiteAutomatizaciones(businessId, automationId);
  }

  automation.isActive = activando;
  await automation.save();
  return { isActive: automation.isActive };
};

// ─── 7. getAutomationLogs ────────────────────────────────────────────────────

const getAutomationLogs = async (businessId, automationId, page = 1, limit = 20) => {
  await getAutomationById(businessId, automationId); // access check

  const skip = (Number(page) - 1) * Number(limit);
  const [logs, total] = await Promise.all([
    AutomationLog.find({ business: businessId, automation: automationId })
      .populate('lead', 'name email company')
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    AutomationLog.countDocuments({ business: businessId, automation: automationId }),
  ]);

  return { logs, total };
};

// ─── 8. testAutomation (dry-run con lead real) ────────────────────────────────

const testAutomation = async (businessId, automationId, leadId) => {
  const automation = await getAutomationById(businessId, automationId);

  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  // Ejecuta de verdad (no dry-run) con log de tipo 'manual'
  await runAutomation(automation, lead, { manual: true, triggeredBy: 'test' });

  return { message: 'Automatización ejecutada manualmente', automationId, leadId };
};

// ─── 9. obtenerEstadoAutomatizaciones ─────────────────────────────────────────

/**
 * Para GET /automations/status — le da al frontend el límite del plan y
 * cuántas automatizaciones activas tiene el negocio ahora mismo, para poder
 * mostrar el candado/CTA sin tener que adivinar contando la lista completa.
 */
const obtenerEstadoAutomatizaciones = async (businessId, userId) => {
  await asegurarAutomatizacionesSemilla(businessId, userId);

  const sub = await subscriptionService.getCurrentSubscription(businessId);
  const limite = sub.plan?.limits?.maxActiveAutomations ?? 0;
  const activas = await Automation.countDocuments({ business: businessId, isActive: true, isDeleted: false });

  return {
    plan: sub.planName,
    limite,
    activas,
    disponibles: limite === -1 ? -1 : Math.max(limite - activas, 0),
  };
};

module.exports = {
  createAutomation,
  listAutomations,
  getAutomationById,
  updateAutomation,
  deleteAutomation,
  toggleActive,
  getAutomationLogs,
  testAutomation,
  obtenerEstadoAutomatizaciones,
  verificarLimiteAutomatizaciones,
};
