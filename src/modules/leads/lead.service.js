const Lead = require('./lead.model');
const Conversation = require('../ai/conversation.model');
const Pipeline = require('../pipeline/pipeline.model');
const { obtenerPipelineEfectivo, validarStageEnPipeline } = require('../pipeline/pipeline.service');
const User = require('../users/user.model');
const Role = require('../roles/role.model');
const Notification = require('../admin/notification.model');
const notificationService = require('../admin/notification.service');
const subscriptionService = require('../subscriptions/subscription.service');
const { AppError } = require('../../middleware/error.middleware');
const { triggerAutomations } = require('../automations/automation.engine');
const { normalizeToE164 } = require('../../utils/phone');
const { escapeRegex } = require('../../utils/regex');
const logger = require('../../utils/logger');

const crearLead = async (businessId, actor, data) => {
  const { note, ...leadData } = data;

  // Bloqueo duro de plan (auditoría de pricing del 23/ago/2026) — este es
  // el ÚNICO camino de creación que rechaza; los automáticos (WhatsApp
  // entrante, automatizaciones) son fail-soft, ver notifyIfOverLeadLimit()
  // más abajo. Va primero, antes de cualquier otra validación, para no
  // gastar queries en un intento que de todos modos se va a rechazar.
  const { allowed, current, limit } = await subscriptionService.checkLeadLimit(businessId);
  if (!allowed) {
    throw new AppError(
      `Llegaste al límite de leads activos de tu plan (${current}/${limit}). Cerrá alguna oportunidad o subí de plan para agregar más.`,
      403
    );
  }

  // Validación de duplicados por teléfono (Problema 4 — antes no existía
  // ningún chequeo, ver diagnóstico previo). No se fusiona ni se reutiliza
  // el lead existente automáticamente — se rechaza con 409 explícito para
  // que quien lo crea decida (mismo principio de "no fusionar
  // automáticamente" usado en toda la Fase 0). El índice {business, phone}
  // sigue siendo no-único a nivel de esquema hasta el Paso 3.
  if (leadData.phone) {
    const phoneNormalizado = normalizeToE164(leadData.phone);
    const existente = await Lead.findOne({ business: businessId, phone: phoneNormalizado, isDeleted: false });
    if (existente) {
      throw new AppError(`Ya existe un lead con este teléfono: ${existente.name}, ${existente._id}`, 409);
    }
  }

  let pipeline = await Pipeline.findOne({ business: businessId, isDefault: true, isActive: true });
  if (!pipeline) {
    pipeline = await Pipeline.createDefault(businessId, actor._id);
  }

  // Si no viene stage explícito, se usa el primer stage del pipeline (por
  // `order`) en vez de asumir que existe una key 'new' — el pipeline del
  // negocio puede tener stages 100% personalizados.
  const primerStage = [...pipeline.stages].sort((a, b) => a.order - b.order)[0];
  const stage = leadData.pipelineStage || primerStage?.key || 'new';
  validarStageEnPipeline(pipeline, stage);
  const stageConfig = pipeline.stages.find((s) => s.key === stage);

  const lead = new Lead({
    ...leadData,
    pipelineStage: stage,
    business: businessId,
    pipeline: pipeline._id,
    stageChangedAt: new Date(),
    closeProbability: stageConfig?.defaultProbability ?? 0,
    activity: [
      {
        type: 'created',
        description: `Lead creado por ${actor.name}`,
        performedBy: actor._id,
        performedByName: actor.name,
      },
    ],
  });

  if (leadData.assignedTo) {
    const assignedUser = await User.findOne({ _id: leadData.assignedTo, business: businessId, isActive: true });
    if (!assignedUser) throw new AppError('Usuario asignado no pertenece a este negocio', 400);
    lead.assignedToName = assignedUser.name;
  }

  if (note) {
    lead.notes.push({ content: note, createdBy: actor._id, createdByName: actor.name });
    lead.activity.push({
      type: 'note_added',
      description: 'Nota inicial agregada',
      performedBy: actor._id,
      performedByName: actor.name,
    });
  }

  await lead.save();

  // Solo un lead que llega por un mensaje de WhatsApp ENTRANTE obtiene una
  // Conversation automáticamente (ensureLeadAndConversation()/
  // processGupshupMessage() en el flujo del webhook). Un lead creado acá
  // (manual), importado (import.service.js) o por publicidad
  // (processMetaLead/processTikTokLead en webhook.service.js) no pasaba
  // por ningún flujo que le creara una — el panel de chat no tenía ningún
  // conversationId que usar hasta el primer mensaje real de WhatsApp, y
  // sendMessage/sendAgentMessage (que requieren un conversationId ya
  // existente) rechazaban con 404 ("conversación no encontrada"). Se crea
  // acá, al alta, para que CUALQUIER lead tenga una Conversation lista
  // para usar sin importar su origen — mismo shape que ya usa
  // startConversation() (ai.controller.js) para este mismo caso.
  await Conversation.create({
    business:   businessId,
    lead:       lead._id,
    assignedTo: actor._id,
    channel:    'manual',
    status:     'active',
    aiEnabled:  true,
  });

  // Trigger asíncrono — no bloquea la respuesta HTTP
  triggerAutomations('lead_created', lead).catch(() => {});

  return lead;
};

const obtenerLead = async (businessId, leadId) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false })
    .populate('assignedTo', 'name email avatar')
    .populate('pipeline', 'name stages');

  if (!lead) throw new AppError('Lead no encontrado', 404);
  return lead;
};

/**
 * Resuelve `search` (listarLeads()) contra 2 criterios distintos y une los
 * resultados — mutando `query` para que quede filtrando por `_id: {$in:...}`,
 * listo para que el resto de listarLeads() siga exactamente igual que antes.
 *
 * IMPORTANTE — por qué son 2 queries separadas y no un solo `$or`: MongoDB
 * NO permite combinar `$text` con `$or`/`$nor` junto a otros operadores en
 * la misma query. Probado en vivo contra Mongo: `{$or:[{$text:...},
 * {phone:{$regex:...}}]}` tira `planner returned error :: caused by ::
 * No query solutions` — el índice de texto no se puede anidar dentro de un
 * `$or`. No es una limitación de este código ni una decisión de diseño
 * "simplificable" — si en algún momento alguien intenta unificar esto en
 * un solo `find()`, va a chocar con el mismo error del motor.
 *
 * `name`/`email`/`company` siguen resolviéndose por `$text` (tokenizado
 * por palabras completas — funciona bien para texto real). `phone` NO
 * puede usar `$text` (un teléfono es un solo token largo, sin espacios
 * que tokenizar: buscar "922" nunca matchea "+51922800127" por $text) —
 * se resuelve aparte, por `$regex` de substring, ver buscarPorTelefono().
 */
const aplicarFiltroDeBusqueda = async (query, search) => {
  const [porTexto, porTelefono] = await Promise.all([
    Lead.distinct('_id', { ...query, $text: { $search: search } }),
    buscarPorTelefono(query, search),
  ]);

  const idsUnicos = new Set([...porTexto, ...porTelefono].map((id) => id.toString()));
  query._id = { $in: [...idsUnicos] };
};

/**
 * `phone` se guarda siempre normalizado a E.164 sin separadores
 * (normalizeToE164(), utils/phone.js — ej. "+51922800127"), así que el
 * término de búsqueda se limpia de todo lo que no sea dígito con el mismo
 * criterio antes de buscarlo como substring: si no, buscar "922 800 127"
 * (con espacios, como lo escribiría alguien de forma natural) nunca
 * matchearía el dato guardado sin espacios.
 *
 * escapeRegex() es defensa en profundidad, no estrictamente necesaria hoy
 * (un string ya reducido a solo dígitos no tiene nada que escapar) — pero
 * blinda igual contra caracteres especiales de regex (rompen la query) o
 * un patrón costoso tipo ReDoS si esta función alguna vez deja de limpiar
 * antes de escapar, o el criterio de limpieza cambia.
 *
 * Sin anclar (no `^.../`): busca el substring en cualquier posición del
 * teléfono — a propósito, es justo lo que $text no podía hacer. Límite
 * conocido: un $regex sin anclar no puede resolverse con el índice de
 * `phone` (ningún índice B-tree puede indexar substrings en posición
 * arbitraria) — Mongo sí usa el índice {business:1, isDeleted:1} ya
 * existente para acotar el scan al negocio antes de aplicar el regex, así
 * que hoy es barato (cientos de leads por negocio, como mucho). Si algún
 * negocio real escala a varios miles de leads activos, esto empieza a
 * pesar — no es un problema hoy, pero no autoresolverlo con un índice
 * nuevo: no existe un índice que resuelva substrings en posición
 * arbitraria sin una solución aparte (ej. Atlas Search).
 */
const buscarPorTelefono = (query, search) => {
  const soloDigitos = search.replace(/\D/g, '');
  if (!soloDigitos) return Promise.resolve([]);

  const regex = new RegExp(escapeRegex(soloDigitos));
  return Lead.distinct('_id', { ...query, phone: regex });
};

const listarLeads = async (businessId, filtros, actorId, ownOnly = false) => {
  const {
    page = 1,
    limit = 20,
    search,
    stage,
    pipeline,
    temperature,
    source,
    assignedTo,
    tags,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    includeArchived = false,
    dateFrom,
    dateTo,
  } = filtros;

  const skip = (Number(page) - 1) * Number(limit);
  const query = { business: businessId, isDeleted: false };

  if (ownOnly) {
    query.assignedTo = actorId;
  }

  if (!includeArchived) {
    query.isArchived = false;
  }

  if (stage) {
    query.pipelineStage = { $in: Array.isArray(stage) ? stage : [stage] };
  }
  // Acota `stage` a UN pipeline específico — ver el comentario en
  // listLeadsSchema (lead.validator.js) sobre por qué hace falta.
  if (pipeline) {
    query.pipeline = pipeline;
  }
  if (temperature) {
    query.temperature = { $in: Array.isArray(temperature) ? temperature : [temperature] };
  }
  if (source) {
    query.source = { $in: Array.isArray(source) ? source : [source] };
  }

  if (assignedTo && !ownOnly) {
    if (assignedTo === 'unassigned') {
      query.assignedTo = { $exists: false };
    } else {
      query.assignedTo = assignedTo;
    }
  }

  if (tags) {
    const tagsArr = Array.isArray(tags) ? tags : [tags];
    query.tags = { $in: tagsArr };
  }

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  // Va al final, después de aplicar el resto de los filtros — necesita el
  // `query` ya completo (business/stage/temperature/etc.) como base común
  // para las 2 sub-búsquedas de abajo.
  if (search) {
    await aplicarFiltroDeBusqueda(query, search);
  }

  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [leads, total] = await Promise.all([
    Lead.find(query)
      .populate('assignedTo', 'name email avatar')
      .sort(sort)
      .skip(skip)
      .limit(Number(limit))
      .select('-notes -activity'),
    Lead.countDocuments(query),
  ]);

  return { leads, total };
};

const actualizarLead = async (businessId, leadId, actor, data) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  if (data.pipelineStage !== undefined) {
    const pipeline = await obtenerPipelineEfectivo(businessId, lead.pipeline);
    validarStageEnPipeline(pipeline, data.pipelineStage);
  }

  if (data.assignedTo !== undefined) {
    if (data.assignedTo) {
      const assignedUser = await User.findOne({ _id: data.assignedTo, business: businessId, isActive: true });
      if (!assignedUser) throw new AppError('Usuario asignado no pertenece a este negocio', 400);
      data.assignedToName = assignedUser.name;
    } else {
      data.assignedToName = null;
    }
  }

  Object.assign(lead, data);
  lead.activity.push({
    type: 'updated',
    description: `Lead actualizado por ${actor.name}`,
    performedBy: actor._id,
    performedByName: actor.name,
  });

  await lead.save();

  triggerAutomations('lead_assigned', lead, { assignedTo: data.assignedTo }).catch(() => {});

  return lead;
};

const eliminarLead = async (businessId, leadId, actor) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);
  await lead.softDelete(actor._id, actor.name);
};

const agregarNota = async (businessId, leadId, actor, content) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  lead.notes.push({ content, createdBy: actor._id, createdByName: actor.name });
  lead.activity.push({
    type: 'note_added',
    description: `Nota agregada por ${actor.name}`,
    performedBy: actor._id,
    performedByName: actor.name,
  });
  lead.lastContactedAt = new Date();

  await lead.save();
  return lead.notes[lead.notes.length - 1];
};

/**
 * options.triggerAutomation (default true) — lo usa
 * automation.engine.js#execChangeStage() con `false`: preserva el
 * comportamiento de siempre de ese archivo (una automatización con acción
 * change_stage nunca disparó otras automatizaciones con trigger
 * lead_stage_changed, a diferencia del endpoint manual y de la tool
 * update_lead_stage de la IA, que sí lo hacen). Reusar cambiarEtapa()
 * desde ahí sin este flag habría hecho que change_stage empiece a
 * cascadear en automatizaciones nuevas — un cambio de comportamiento no
 * pedido, con riesgo real de loop infinito si 2 automatizaciones ya
 * configuradas terminan "respondiéndose" mutuamente vía change_stage
 * (A dispara con trigger lead_stage_changed→to:X, acción change_stage→Y;
 * B dispara con trigger lead_stage_changed→to:Y, acción change_stage→X).
 * Los otros 2 llamadores (lead.controller.js, ai/tools/index.js) no pasan
 * este 5to argumento, así que quedan con el default true, sin cambios.
 */
const cambiarEtapa = async (businessId, leadId, actor, stage, reason, { triggerAutomation = true } = {}) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  // Tenant-aware: se valida contra los stages reales del pipeline de ESTE
  // negocio (el propio del lead, o el default del negocio si no tiene uno
  // asignado), no contra un enum fijo — ver pipeline.service.js.
  const pipeline = await obtenerPipelineEfectivo(businessId, lead.pipeline);
  validarStageEnPipeline(pipeline, stage);

  const etapaAnterior = lead.pipelineStage;
  lead.pipelineStage = stage;
  lead.stageChangedAt = new Date();

  const stageConfig = pipeline.stages.find((s) => s.key === stage);
  if (stageConfig) lead.closeProbability = stageConfig.defaultProbability;

  lead.activity.push({
    type: 'stage_changed',
    description: `Etapa cambiada de ${etapaAnterior} a ${stage} por ${actor.name}`,
    performedBy: actor._id,
    performedByName: actor.name,
    meta: { from: etapaAnterior, to: stage, reason },
  });

  await lead.save();

  if (triggerAutomation) {
    triggerAutomations('lead_stage_changed', lead, { from: etapaAnterior, to: stage }).catch(() => {});
  }

  return lead;
};

const asignarLead = async (businessId, leadId, actor, assignedToId) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  const assignedUser = await User.findOne({ _id: assignedToId, business: businessId, isActive: true });
  if (!assignedUser) throw new AppError('Usuario no encontrado en este negocio', 400);

  lead.assignedTo = assignedToId;
  lead.assignedToName = assignedUser.name;
  lead.activity.push({
    type: 'assigned',
    description: `Lead asignado a ${assignedUser.name} por ${actor.name}`,
    performedBy: actor._id,
    performedByName: actor.name,
    meta: { assignedToId, assignedToName: assignedUser.name },
  });

  await lead.save();

  triggerAutomations('lead_assigned', lead, { assignedToId, assignedToName: assignedUser.name }).catch(() => {});

  return lead;
};

const accionMasiva = async (businessId, actor, { leadIds, action, assignedTo, stage, tag }) => {
  const leads = await Lead.find({ _id: { $in: leadIds }, business: businessId, isDeleted: false });
  if (!leads.length) throw new AppError('No se encontraron leads válidos', 404);

  let assignedUser = null;
  if (action === 'assign') {
    assignedUser = await User.findOne({ _id: assignedTo, business: businessId, isActive: true });
    if (!assignedUser) throw new AppError('Usuario de asignación no válido', 400);
  }

  const resultados = { procesados: 0, errores: [] };

  for (const lead of leads) {
    try {
      switch (action) {
        case 'delete':
          await lead.softDelete(actor._id, actor.name);
          break;
        case 'archive':
          lead.isArchived = true;
          lead.activity.push({ type: 'updated', description: 'Lead archivado (masivo)', performedBy: actor._id, performedByName: actor.name });
          await lead.save();
          break;
        case 'assign':
          lead.assignedTo = assignedTo;
          lead.assignedToName = assignedUser.name;
          lead.activity.push({ type: 'assigned', description: `Asignado masivamente a ${assignedUser.name}`, performedBy: actor._id, performedByName: actor.name });
          await lead.save();
          break;
        case 'change_stage': {
          // Cada lead puede pertenecer a un pipeline distinto (o no tener uno
          // asignado), así que se valida individualmente y tenant-aware —
          // un lead con stage inválido para SU pipeline cae en el catch de
          // abajo y se reporta en `errores` sin abortar el resto del batch.
          const pipeline = await obtenerPipelineEfectivo(businessId, lead.pipeline);
          validarStageEnPipeline(pipeline, stage);

          const etapaAnterior = lead.pipelineStage;
          lead.pipelineStage = stage;
          lead.stageChangedAt = new Date();
          lead.activity.push({ type: 'stage_changed', description: `Etapa cambiada masivamente a ${stage}`, performedBy: actor._id, performedByName: actor.name, meta: { from: etapaAnterior, to: stage } });
          await lead.save();
          break;
        }
        case 'add_tag':
          if (!lead.tags.includes(tag)) lead.tags.push(tag);
          lead.activity.push({ type: 'updated', description: `Tag "${tag}" agregado (masivo)`, performedBy: actor._id, performedByName: actor.name });
          await lead.save();
          break;
      }
      resultados.procesados++;
    } catch (err) {
      resultados.errores.push({ leadId: lead._id.toString(), error: err.message });
    }
  }

  return resultados;
};

/**
 * Resuelve a qué usuario(s) avisar de un evento de un lead (hoy: el
 * disparador "lead_message" de webhook.service.js — un mensaje entrante
 * con la IA apagada).
 *
 * Si el lead tiene assignedTo, ese usuario específico — comportamiento
 * histórico, sin cambios. Si NO tiene assignedTo, cae a TODOS los
 * admins/dueños activos del negocio (roles 'owner'/'admin', del sistema o
 * custom del negocio si el negocio definió los suyos) — así un negocio
 * nuevo, o cualquier lead sin nadie asignado todavía, no pierde en
 * silencio el aviso de un mensaje real de un cliente. Crítico para
 * lanzar multi-tenant: antes de esto, un lead sin assignedTo nunca
 * notificaba a nadie.
 *
 * 'superadmin' queda afuera del fallback a propósito — es el rol de
 * operador de la plataforma CREA OS (cross-tenant), no "admin de este
 * negocio"; incluirlo notificaría a operadores de la plataforma por cada
 * negocio con el que tengan una cuenta asociada, que no es la intención
 * de este fallback.
 *
 * Nunca lanza — si no hay ni assignedTo ni ningún admin/owner activo en
 * el negocio (caso raro, no debería pasar en un negocio bien configurado),
 * loguea un warning claro con el businessId para que sea detectable en
 * Railway logs, y devuelve un array vacío. El llamador decide qué hacer
 * con un array vacío (hoy: simplemente no notificar a nadie).
 *
 * @returns {Promise<Array<ObjectId>>} 0, 1, o varios userIds
 */
const resolveNotificationRecipients = async (lead) => {
  if (lead.assignedTo) return [lead.assignedTo];

  const roles = await Role.find({
    slug: { $in: ['owner', 'admin'] },
    business: { $in: [null, lead.business] },
  }).select('_id');

  if (!roles.length) {
    logger.warn(`resolveNotificationRecipients(): no existen roles 'owner'/'admin' aplicables al negocio ${lead.business} — no se pudo notificar`);
    return [];
  }

  const admins = await User.find({
    business: lead.business,
    isActive: true,
    role: { $in: roles.map((r) => r._id) },
  }).select('_id');

  if (!admins.length) {
    logger.warn(`resolveNotificationRecipients(): sin assignedTo ni ningún admin/owner activo en el negocio ${lead.business} — no se pudo notificar`);
    return [];
  }

  return admins.map((u) => u._id);
};

// No se repite el aviso más seguido que esto mientras el negocio siga
// excedido — evita que un negocio permanentemente sobre el límite reciba
// una notificación por cada mensaje nuevo de WhatsApp (podrían ser
// decenas por día). 24h: suficiente frecuencia para que sea accionable sin
// ser spam. Se implementa consultando la última notificación de este tipo
// en vez de guardar un timestamp aparte — mismo criterio que el resto del
// módulo de notificaciones, sin estado nuevo que mantener sincronizado.
const RECORDATORIO_LIMITE_MS = 24 * 60 * 60 * 1000;

/**
 * Fail-soft — para los caminos AUTOMÁTICOS de creación de leads (WhatsApp
 * entrante, automatizaciones; ver automation.engine.js, webhook.service.js,
 * inbound.worker.js). El lead ya se creó SIEMPRE antes de llamar esto —
 * nunca se pierde una conversación real de WhatsApp por un límite de plan
 * (a diferencia de crearLead()/import.service.js, que sí bloquean antes de
 * crear). Se llama fire-and-forget (`.catch(() => {})`), mismo patrón que
 * triggerAutomations('lead_created', lead) unas líneas más abajo en
 * crearLead().
 *
 * Además de notificar, marca `lead.overQuota = true` — se hace acá (no en
 * cada uno de los ~6 sitios que crean leads automáticos) para que integrar
 * esto en un sitio nuevo sea agregar una sola línea, sin duplicar lógica.
 */
const notifyIfOverLeadLimit = async (lead) => {
  const { allowed, current, limit } = await subscriptionService.checkLeadLimit(lead.business);
  if (allowed) return;

  if (!lead.overQuota) {
    await Lead.updateOne({ _id: lead._id }, { $set: { overQuota: true } });
  }

  const ultimoAviso = await Notification.findOne({
    business: lead.business,
    category: 'subscription',
    'meta.event': 'lead_limit_exceeded',
  }).sort({ createdAt: -1 }).select('createdAt').lean();

  if (ultimoAviso && Date.now() - new Date(ultimoAviso.createdAt).getTime() < RECORDATORIO_LIMITE_MS) {
    return; // ya se avisó hace menos de 24h — no repetir
  }

  const destinatarios = await resolveNotificationRecipients(lead);
  for (const userId of destinatarios) {
    try {
      await notificationService.createNotification({
        business: lead.business,
        user: userId,
        type: 'warning',
        category: 'subscription',
        title: 'Llegaste al límite de leads activos',
        message: `Tenés ${current}/${limit} leads activos. Considerá subir de plan o cerrar oportunidades viejas para seguir recibiendo leads nuevos sin límite.`,
        meta: { leadId: lead._id, current, limit, event: 'lead_limit_exceeded' },
      });
    } catch (err) {
      logger.error('[leads] createNotification() falló para lead_limit_exceeded (no afecta el lead ya creado)', {
        leadId: lead._id.toString(),
        userId: userId.toString(),
        error: err.message,
      });
    }
  }
};

module.exports = {
  crearLead,
  obtenerLead,
  listarLeads,
  actualizarLead,
  eliminarLead,
  agregarNota,
  cambiarEtapa,
  asignarLead,
  accionMasiva,
  resolveNotificationRecipients,
  notifyIfOverLeadLimit,
};
