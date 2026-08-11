const Pipeline = require('./pipeline.model');
const Lead = require('../leads/lead.model');
const { AppError } = require('../../middleware/error.middleware');

const obtenerOCrearDefault = async (businessId, userId) => {
  let pipeline = await Pipeline.findOne({ business: businessId, isDefault: true, isActive: true });
  if (!pipeline) {
    pipeline = await Pipeline.createDefault(businessId, userId);
  }
  return pipeline;
};

/**
 * Resuelve el pipeline "efectivo" a usar para validar un stage: el indicado por
 * `pipelineId` si existe y pertenece al negocio, o si no (lead sin pipeline
 * asignado, o pipeline borrado), el pipeline default del negocio — creándolo
 * si el negocio todavía no tiene uno (mismo fallback que ya usa crearLead()).
 */
const obtenerPipelineEfectivo = async (businessId, pipelineId) => {
  if (pipelineId) {
    const pipeline = await Pipeline.findOne({ _id: pipelineId, business: businessId, isActive: true });
    if (pipeline) return pipeline;
  }
  return obtenerOCrearDefault(businessId);
};

/**
 * Valida (fail-closed) que `stage` exista entre los stages configurados en el
 * pipeline dado. Tenant-aware porque `pipeline` ya viene acotado al negocio
 * (ver obtenerPipelineEfectivo). Lanza AppError 400 listando los stages reales
 * del negocio, para que el error sea accionable en vez de un enum genérico.
 */
const validarStageEnPipeline = (pipeline, stage) => {
  const stagesValidos = pipeline.stages.map((s) => s.key);
  if (!stagesValidos.includes(stage)) {
    throw new AppError(
      `"stage" debe ser uno de los valores configurados en el pipeline de este negocio: [${stagesValidos.join(', ')}]`,
      400
    );
  }
};

const listarPipelines = async (businessId) => {
  return Pipeline.find({ business: businessId, isActive: true }).sort({ isDefault: -1, createdAt: 1 });
};

const obtenerPipeline = async (businessId, pipelineId) => {
  const pipeline = await Pipeline.findOne({ _id: pipelineId, business: businessId, isActive: true });
  if (!pipeline) throw new AppError('Pipeline no encontrado', 404);
  return pipeline;
};

const crearPipeline = async (businessId, userId, { name, description, stages }) => {
  return Pipeline.create({ business: businessId, createdBy: userId, name, description, stages });
};

const actualizarPipeline = async (businessId, pipelineId, data) => {
  const pipeline = await Pipeline.findOne({ _id: pipelineId, business: businessId, isActive: true });
  if (!pipeline) throw new AppError('Pipeline no encontrado', 404);

  if (pipeline.isDefault && data.isDefault === false) {
    throw new AppError('No puedes desactivar el pipeline predeterminado directamente', 400);
  }

  const camposPermitidos = ['name', 'description', 'stages', 'isDefault'];
  for (const key of camposPermitidos) {
    if (data[key] !== undefined) pipeline[key] = data[key];
  }

  await pipeline.save();
  return pipeline;
};

const obtenerTablero = async (businessId, pipelineId) => {
  const pipeline = await obtenerPipeline(businessId, pipelineId);

  const grupos = await Lead.aggregate([
    {
      $match: {
        business: pipeline.business,
        pipeline: pipeline._id,
        isDeleted: false,
        isArchived: false,
      },
    },
    {
      $group: {
        _id: '$pipelineStage',
        leads: {
          $push: {
            _id: '$_id',
            name: '$name',
            email: '$email',
            company: '$company',
            potentialValue: '$potentialValue',
            temperature: '$temperature',
            assignedToName: '$assignedToName',
            closeProbability: '$closeProbability',
            createdAt: '$createdAt',
            stageChangedAt: '$stageChangedAt',
          },
        },
        count: { $sum: 1 },
        totalValue: { $sum: '$potentialValue' },
      },
    },
  ]);

  const tablero = pipeline.stages.map((stage) => {
    const grupo = grupos.find((g) => g._id === stage.key) || { leads: [], count: 0, totalValue: 0 };
    return {
      stage: stage.key,
      name: stage.name,
      color: stage.color,
      order: stage.order,
      isWon: stage.isWon,
      isLost: stage.isLost,
      count: grupo.count,
      totalValue: grupo.totalValue,
      leads: grupo.leads,
    };
  });

  return { pipeline, tablero };
};

module.exports = {
  obtenerOCrearDefault,
  obtenerPipelineEfectivo,
  validarStageEnPipeline,
  listarPipelines,
  obtenerPipeline,
  crearPipeline,
  actualizarPipeline,
  obtenerTablero,
};
