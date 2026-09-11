const Automation    = require('./automation.model');
const AutomationLog = require('./automation-log.model');
const { runAutomation } = require('./automation.engine');
const Lead          = require('../leads/lead.model');
const subscriptionService = require('../subscriptions/subscription.service');
// Sin riesgo de ciclo: pipeline.service.js solo requiere Pipeline/Lead/
// AppError, nada de automations/.
const pipelineService = require('../pipeline/pipeline.service');
const { AppError }  = require('../../middleware/error.middleware');
const logger        = require('../../utils/logger');

// ─── Límite de plan (automatizaciones ACTIVAS simultáneas) ───────────────────

// Evita inundar los logs si muchos negocios pegan al mismo tiempo antes de
// que alguien corra el seed — se avisa una vez por plan, no por request.
const planesSinSeedAvisados = new Set();

/**
 * Resuelve `maxActiveAutomations` del plan, distinguiendo dos casos que de
 * otro modo serían indistinguibles: "el plan explícitamente da 0" (Starter,
 * comportamiento esperado) vs. "el campo no existe en el Plan porque nadie
 * corrió `npm run seed:plans` después de este cambio" (bug operativo). En el
 * segundo caso cae igual a 0 (fail-closed: nunca se activa de más por un
 * seed faltante), pero deja un logger.error bien ruidoso para que se note en
 * vez de comportarse indistinguible de un Starter legítimo.
 */
const resolverLimitePlan = (sub) => {
  const limite = sub.plan?.limits?.maxActiveAutomations;

  if (limite === undefined) {
    const planName = sub.planName || sub.plan?.name || '?';
    if (!planesSinSeedAvisados.has(planName)) {
      planesSinSeedAvisados.add(planName);
      logger.error(
        `[automations] Plan "${planName}" no tiene "limits.maxActiveAutomations" seteado — ` +
        `¿falta correr "npm run seed:plans"? Cayendo a 0 (fail-closed) hasta que se corra.`
      );
    }
    return 0;
  }

  return limite;
};

/**
 * Verifica (fail-closed) que activar una automatización no exceda
 * `Plan.limits.maxActiveAutomations` del negocio. `excludeAutomationId` se usa
 * al togglear/actualizar una automatización ya existente, para no contarla
 * dos veces contra sí misma. -1 en el límite significa "ilimitado" (mismo
 * convenio que subscriptionService#checkLeadLimit).
 */
const verificarLimiteAutomatizaciones = async (businessId, excludeAutomationId = null) => {
  const sub = await subscriptionService.getCurrentSubscription(businessId);
  const limite = resolverLimitePlan(sub);

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
 * Las 2 automatizaciones fijas que controlan los toggles "Seguimientos
 * automáticos" / "Cierre automático" del frontend (business.tsx — hoy
 * ocultos, PR E1/E2 de esta secuencia los vuelve a mostrar cableados de
 * verdad). Caso 5 del backlog, PR C/6: cablea el trigger y la acción real
 * de cada una — el motor ya soporta trigger por tiempo (Caso 7) y la
 * acción send_template (PR A). `trigger.conditions` usa el umbral por
 * default acordado (mismos días que ya usa mission.service.js, para que
 * la "misión del día" y la automatización real hablen de lo mismo) — el
 * usuario podrá cambiarlo desde la UI (PR E1), esto es solo el valor
 * inicial con el que nace un negocio nuevo.
 *
 * `actions` de 'followup' queda con config:{} a propósito — sin
 * templateId todavía (PR E2 agrega el selector de plantilla en la UI). Si
 * alguien activara esta automatización antes de configurar una plantilla
 * (hoy solo posible pegándole directo a la API, no hay UI para eso
 * todavía), execSendTemplate() falla limpio y queda registrado en su
 * AutomationLog — no es un no-op silencioso, ver automation.engine.js.
 *
 * `actions` de 'auto_close' NO está acá — se arma dinámicamente por
 * negocio en sembrarUnaAutomatizacion(), porque change_stage necesita la
 * key real de la etapa "ganada" del pipeline de CADA negocio (no hay una
 * key fija — cada uno configura su propio pipeline).
 */
const AUTOMATIZACIONES_SEMILLA = [
  {
    type: 'followup',
    name: 'Seguimientos automáticos',
    description:
      'Le manda un WhatsApp al lead cuando pasa varios días sin contactarlo — texto libre si la conversación sigue abierta, o una plantilla aprobada si no. Configurá el umbral de días y la plantilla en Mi Negocio.',
    trigger: {
      type: 'lead_stale',
      conditions: [{ field: 'daysThreshold', operator: 'greater_than', value: 3 }],
    },
    actions: [{ order: 1, type: 'send_template', config: {}, delay: 0 }],
  },
  {
    type: 'auto_close',
    name: 'Cierre automático',
    description:
      'Mueve al lead a la etapa ganada del pipeline cuando pasa varios días sin avanzar de etapa, sin intervención humana. Configurá el umbral de días en Mi Negocio.',
    trigger: {
      type: 'stage_stalled',
      conditions: [{ field: 'daysThreshold', operator: 'greater_than', value: 7 }],
    },
    // Se completa en sembrarUnaAutomatizacion() — ver comentario de arriba.
    actions: null,
  },
];

/**
 * Arma el payload final de UNA semilla para UN negocio puntual — separado
 * de asegurarAutomatizacionesSemilla() para poder resolver 'auto_close'
 * (que necesita datos específicos del negocio) sin bifurcar toda la
 * función. Devuelve `null` (no siembra nada) cuando la semilla no se
 * puede armar para este negocio — hoy el único caso es 'auto_close' sin
 * ninguna etapa "ganada" configurada en el pipeline.
 */
const resolverAccionesSemilla = async (businessId, userId, semilla) => {
  if (semilla.type !== 'auto_close') return semilla.actions;

  const pipeline = await pipelineService.obtenerOCrearDefault(businessId, userId);
  const etapaGanada = pipeline.stages.find((s) => s.isWon);

  if (!etapaGanada) {
    logger.warn(
      `[automations] negocio ${businessId} no tiene ninguna etapa marcada como "ganada" en su pipeline — ` +
      `se salta la semilla "${semilla.name}" (change_stage necesita una etapa destino real). No bloquea el resto del seed.`,
      { businessId, pipelineId: pipeline._id }
    );
    return null;
  }

  return [{ order: 1, type: 'change_stage', config: { stage: etapaGanada.key }, delay: 0 }];
};

/**
 * Siembra UNA automatización para UN negocio — separado de
 * asegurarAutomatizacionesSemilla() (que dispara las 2 en paralelo) para
 * que un fallo resolviendo 'auto_close' (ej. sin etapa ganada) no le
 * pegue a 'followup', y viceversa.
 */
const sembrarUnaAutomatizacion = async (businessId, userId, semilla) => {
  const actions = await resolverAccionesSemilla(businessId, userId, semilla);
  if (!actions) return null; // sin acciones válidas para este negocio — no siembra nada, no revienta el resto

  return Automation.findOneAndUpdate(
    { business: businessId, type: semilla.type },
    {
      $setOnInsert: {
        business: businessId,
        createdBy: userId,
        name: semilla.name,
        description: semilla.description,
        type: semilla.type,
        trigger: semilla.trigger,
        actions,
        isActive: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Crea las automatizaciones semilla si el negocio todavía no las tiene
 * (idempotente vía upsert + $setOnInsert — no pisa nombre/descripción si el
 * usuario ya las editó). Se llama de forma lazy desde listAutomations() y
 * obtenerEstadoAutomatizaciones(), no desde el registro del negocio.
 */
const asegurarAutomatizacionesSemilla = async (businessId, userId) => {
  await Promise.all(
    AUTOMATIZACIONES_SEMILLA.map((semilla) => sembrarUnaAutomatizacion(businessId, userId, semilla))
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
  const limite = resolverLimitePlan(sub);
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
  // Exportados para tests directos y focalizados (Caso 5, PR C/6) — antes
  // solo se ejercitaban indirecto vía listAutomations()/
  // obtenerEstadoAutomatizaciones().
  asegurarAutomatizacionesSemilla,
  AUTOMATIZACIONES_SEMILLA,
};
