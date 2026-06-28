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
  listarPipelines,
  obtenerPipeline,
  crearPipeline,
  actualizarPipeline,
  obtenerTablero,
};
