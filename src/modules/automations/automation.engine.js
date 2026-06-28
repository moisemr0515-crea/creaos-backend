/**
 * Motor de ejecución de automatizaciones.
 * Se invoca de forma asíncrona desde lead.service.js (fire-and-forget).
 * Los errores nunca propagan al request HTTP original.
 */

const Automation      = require('./automation.model');
const AutomationLog   = require('./automation-log.model');
const Lead            = require('../leads/lead.model');
const User            = require('../users/user.model');
const Conversation    = require('../ai/conversation.model');
const Pipeline        = require('../pipeline/pipeline.model');

// ─── Condition evaluation ─────────────────────────────────────────────────────

function getField(lead, field) {
  // Soporte de dot-notation limitado a campos conocidos del Lead
  return field.split('.').reduce((obj, key) => obj?.[key], lead);
}

function evaluateCondition(cond, lead) {
  const val    = getField(lead, cond.field);
  const target = cond.value;

  switch (cond.operator) {
    case 'equals':      return String(val) === String(target);
    case 'not_equals':  return String(val) !== String(target);
    case 'contains':    return String(val ?? '').toLowerCase().includes(String(target).toLowerCase());
    case 'greater_than':return Number(val) > Number(target);
    case 'less_than':   return Number(val) < Number(target);
    default:            return false;
  }
}

function conditionsMet(conditions, lead) {
  if (!conditions?.length) return true;
  return conditions.every((c) => evaluateCondition(c, lead));
}

// ─── Action executors ─────────────────────────────────────────────────────────

async function execAssignLead(config, lead) {
  if (!config.assignTo) throw new Error('assign_lead: falta config.assignTo');
  const user = await User.findOne({ _id: config.assignTo, business: lead.business, isActive: true });
  if (!user) throw new Error(`Usuario ${config.assignTo} no encontrado`);
  lead.assignedTo     = user._id;
  lead.assignedToName = user.name;
  lead.activity.push({ type: 'assigned', description: `Asignado automáticamente a ${user.name}`, performedBy: null, performedByName: 'Automatización' });
  await lead.save();
  return { assignedTo: user.name };
}

async function execChangeStage(config, lead) {
  if (!config.stage) throw new Error('change_stage: falta config.stage');
  const prev          = lead.pipelineStage;
  lead.pipelineStage  = config.stage;
  lead.stageChangedAt = new Date();
  if (lead.pipeline) {
    const pipeline = await Pipeline.findById(lead.pipeline);
    const stageCfg = pipeline?.stages.find((s) => s.key === config.stage);
    if (stageCfg) lead.closeProbability = stageCfg.defaultProbability;
  }
  lead.activity.push({ type: 'stage_changed', description: `Etapa cambiada de ${prev} a ${config.stage} (automatización)`, performedBy: null, performedByName: 'Automatización', meta: { from: prev, to: config.stage } });
  await lead.save();
  return { from: prev, to: config.stage };
}

async function execAddTag(config, lead) {
  if (!config.tag) throw new Error('add_tag: falta config.tag');
  if (!lead.tags.includes(config.tag)) {
    lead.tags.push(config.tag);
    lead.activity.push({ type: 'updated', description: `Tag "${config.tag}" agregado (automatización)`, performedBy: null, performedByName: 'Automatización' });
    await lead.save();
  }
  return { tag: config.tag };
}

async function execAddNote(config, lead) {
  if (!config.content) throw new Error('add_note: falta config.content');
  lead.notes.push({ content: config.content, createdBy: null, createdByName: 'Automatización' });
  lead.activity.push({ type: 'note_added', description: 'Nota agregada por automatización', performedBy: null, performedByName: 'Automatización' });
  await lead.save();
  return { noteAdded: true };
}

async function execUpdateLead(config, lead) {
  const ALLOWED = ['temperature', 'source', 'potentialValue', 'currency', 'expectedCloseDate', 'closeProbability', 'company', 'position'];
  const updates = {};
  for (const key of ALLOWED) {
    if (config[key] !== undefined) {
      lead[key] = config[key];
      updates[key] = config[key];
    }
  }
  if (!Object.keys(updates).length) throw new Error('update_lead: ningún campo válido en config');
  lead.activity.push({ type: 'updated', description: 'Lead actualizado por automatización', performedBy: null, performedByName: 'Automatización' });
  await lead.save();
  return { updated: updates };
}

async function execCreateLead(config, lead) {
  // Crea un nuevo lead en el mismo negocio — útil para duplicar o crear lead hijo
  const newLead = await Lead.create({
    business:      lead.business,
    name:          config.name || `Nuevo lead desde ${lead.name}`,
    email:         config.email,
    phone:         config.phone,
    company:       config.company,
    source:        config.source || lead.source,
    pipelineStage: config.pipelineStage || 'new',
    temperature:   config.temperature || 'warm',
    assignedTo:    config.assignTo || lead.assignedTo,
    assignedToName:config.assignTo ? undefined : lead.assignedToName,
    activity: [{ type: 'created', description: 'Lead creado por automatización', performedBy: null, performedByName: 'Automatización' }],
  });
  return { createdLeadId: newLead._id };
}

async function execStartAIConversation(config, lead) {
  const existing = await Conversation.findOne({ business: lead.business, lead: lead._id, status: 'active', isDeleted: false });
  if (existing) return { conversationId: existing._id, reused: true };
  const conv = await Conversation.create({
    business:  lead.business,
    lead:      lead._id,
    channel:   config.channel || 'manual',
    status:    'active',
    aiEnabled: true,
  });
  return { conversationId: conv._id };
}

async function execSendNotification(config, lead) {
  // In-app: se registra en el activity log del lead. En producción: WebSocket / push.
  const msg = config.message || `Notificación automática para lead ${lead.name}`;
  lead.activity.push({ type: 'note_added', description: `[Notificación] ${msg}`, performedBy: null, performedByName: 'Automatización' });
  await lead.save();
  return { notified: true, message: msg };
}

async function execWait(config) {
  const seconds = Math.min(Number(config.seconds) || 0, 30); // máx 30s en runtime
  if (seconds > 0) await new Promise((r) => setTimeout(r, seconds * 1000));
  return { waited: seconds };
}

// ─── Action dispatcher ────────────────────────────────────────────────────────

async function executeAction(action, lead) {
  switch (action.type) {
    case 'assign_lead':          return execAssignLead(action.config, lead);
    case 'change_stage':         return execChangeStage(action.config, lead);
    case 'add_tag':              return execAddTag(action.config, lead);
    case 'add_note':             return execAddNote(action.config, lead);
    case 'update_lead':          return execUpdateLead(action.config, lead);
    case 'create_lead':          return execCreateLead(action.config, lead);
    case 'start_ai_conversation':return execStartAIConversation(action.config, lead);
    case 'send_notification':    return execSendNotification(action.config, lead);
    case 'wait':                 return execWait(action.config);
    default:                     throw new Error(`Tipo de acción desconocido: ${action.type}`);
  }
}

// ─── Core runner ──────────────────────────────────────────────────────────────

async function runAutomation(automation, lead, triggerData) {
  const startedAt = Date.now();
  const log = await AutomationLog.create({
    business:   automation.business,
    automation: automation._id,
    lead:       lead._id,
    trigger:    { type: automation.trigger.type, data: triggerData },
    status:     'running',
    startedAt:  new Date(startedAt),
  });

  const actionsExecuted = [];
  let overallStatus = 'completed';
  let globalError;

  const sortedActions = [...automation.actions].sort((a, b) => a.order - b.order);

  for (const action of sortedActions) {
    // Respeta delay configurado (hasta 30s en runtime)
    if (action.delay > 0) {
      await new Promise((r) => setTimeout(r, Math.min(action.delay, 30) * 1000));
    }

    const execAt = new Date();
    try {
      // Re-fetch lead to get latest state after previous actions
      const freshLead = await Lead.findById(lead._id);
      if (!freshLead || freshLead.isDeleted) {
        actionsExecuted.push({ order: action.order, type: action.type, status: 'skipped', error: 'Lead eliminado', executedAt: execAt });
        break;
      }
      const result = await executeAction(action, freshLead);
      actionsExecuted.push({ order: action.order, type: action.type, status: 'success', result, executedAt: execAt });
    } catch (err) {
      actionsExecuted.push({ order: action.order, type: action.type, status: 'failed', error: err.message, executedAt: execAt });
      overallStatus = 'partial';
    }
  }

  const durationMs  = Date.now() - startedAt;
  const completedAt = new Date();

  await AutomationLog.findByIdAndUpdate(log._id, { status: overallStatus, actionsExecuted, completedAt, durationMs, error: globalError });

  const incDelta = { 'stats.totalExecutions': 1 };
  if (overallStatus === 'completed') incDelta['stats.successCount'] = 1;
  else incDelta['stats.errorCount'] = 1;

  await Automation.findByIdAndUpdate(automation._id, {
    $inc: incDelta,
    $set: { 'stats.lastExecutedAt': completedAt },
  });
}

// ─── Public trigger entry point ───────────────────────────────────────────────

async function triggerAutomations(triggerType, lead, triggerData = {}) {
  try {
    const automations = await Automation.find({
      business:      lead.business,
      'trigger.type': triggerType,
      isActive:      true,
      isDeleted:     false,
    });

    for (const auto of automations) {
      if (!conditionsMet(auto.trigger.conditions, lead)) continue;
      // Fire-and-forget: no awaited so it never blocks the HTTP response
      runAutomation(auto, lead, triggerData).catch((err) =>
        console.error(`[automation] Error en ${auto.name}:`, err.message)
      );
    }
  } catch (err) {
    console.error('[automation] triggerAutomations error:', err.message);
  }
}

module.exports = { triggerAutomations, conditionsMet, runAutomation };
