const Lead = require('./lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const User = require('../users/user.model');
const { AppError } = require('../../middleware/error.middleware');
const { triggerAutomations } = require('../automations/automation.engine');

const crearLead = async (businessId, actor, data) => {
  const { note, ...leadData } = data;

  let pipeline = await Pipeline.findOne({ business: businessId, isDefault: true, isActive: true });
  if (!pipeline) {
    pipeline = await Pipeline.createDefault(businessId, actor._id);
  }

  const stage = leadData.pipelineStage || 'new';
  const stageConfig = pipeline.stages.find((s) => s.key === stage);

  const lead = new Lead({
    ...leadData,
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

const listarLeads = async (businessId, filtros, actorId, ownOnly = false) => {
  const {
    page = 1,
    limit = 20,
    search,
    stage,
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

  if (search) {
    query.$text = { $search: search };
  }

  if (stage) {
    query.pipelineStage = { $in: Array.isArray(stage) ? stage : [stage] };
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

const cambiarEtapa = async (businessId, leadId, actor, stage, reason) => {
  const lead = await Lead.findOne({ _id: leadId, business: businessId, isDeleted: false });
  if (!lead) throw new AppError('Lead no encontrado', 404);

  const etapaAnterior = lead.pipelineStage;
  lead.pipelineStage = stage;
  lead.stageChangedAt = new Date();

  if (lead.pipeline) {
    const pipeline = await Pipeline.findById(lead.pipeline);
    if (pipeline) {
      const stageConfig = pipeline.stages.find((s) => s.key === stage);
      if (stageConfig) lead.closeProbability = stageConfig.defaultProbability;
    }
  }

  lead.activity.push({
    type: 'stage_changed',
    description: `Etapa cambiada de ${etapaAnterior} a ${stage} por ${actor.name}`,
    performedBy: actor._id,
    performedByName: actor.name,
    meta: { from: etapaAnterior, to: stage, reason },
  });

  await lead.save();

  triggerAutomations('lead_stage_changed', lead, { from: etapaAnterior, to: stage }).catch(() => {});

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
};
