const Automation    = require('./automation.model');
const AutomationLog = require('./automation-log.model');
const { runAutomation } = require('./automation.engine');
const Lead          = require('../leads/lead.model');
const { AppError }  = require('../../middleware/error.middleware');

// ─── 1. createAutomation ─────────────────────────────────────────────────────

const createAutomation = async (businessId, data, userId) => {
  const automation = await Automation.create({
    business:  businessId,
    createdBy: userId,
    name:      data.name,
    description: data.description,
    trigger:   data.trigger,
    actions:   data.actions,
    isActive:  data.isActive ?? true,
  });
  return automation;
};

// ─── 2. listAutomations ───────────────────────────────────────────────────────

const listAutomations = async (businessId, filters = {}) => {
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

  const automation = await Automation.findOneAndUpdate(
    { _id: automationId, business: businessId, isDeleted: false },
    { $set: updates },
    { new: true, runValidators: true }
  );
  if (!automation) throw new AppError('Automatización no encontrada', 404);
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
  automation.isActive = !automation.isActive;
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

module.exports = {
  createAutomation,
  listAutomations,
  getAutomationById,
  updateAutomation,
  deleteAutomation,
  toggleActive,
  getAutomationLogs,
  testAutomation,
};
