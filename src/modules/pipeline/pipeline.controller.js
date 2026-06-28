const pipelineService = require('./pipeline.service');
const { validateBody } = require('../../shared/utils/validate');
const { respuestaExito } = require('../../utils/response');
const Joi = require('joi');

const createPipelineSchema = Joi.object({
  name:        Joi.string().max(100).required(),
  description: Joi.string().max(500).optional().allow(''),
  stages: Joi.array()
    .items(
      Joi.object({
        key:                Joi.string().required(),
        name:               Joi.string().required(),
        order:              Joi.number().integer().min(1).required(),
        color:              Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).optional(),
        isWon:              Joi.boolean().optional(),
        isLost:             Joi.boolean().optional(),
        defaultProbability: Joi.number().min(0).max(100).optional(),
      })
    )
    .optional(),
});

const getDefault = async (req, res, next) => {
  try {
    const pipeline = await pipelineService.obtenerOCrearDefault(req.businessId, req.user._id);
    return respuestaExito(res, { message: 'Pipeline predeterminado obtenido', data: { pipeline } });
  } catch (err) {
    next(err);
  }
};

const listPipelines = async (req, res, next) => {
  try {
    const pipelines = await pipelineService.listarPipelines(req.businessId);
    return respuestaExito(res, { message: 'Pipelines obtenidos exitosamente', data: { pipelines } });
  } catch (err) {
    next(err);
  }
};

const getPipeline = async (req, res, next) => {
  try {
    const pipeline = await pipelineService.obtenerPipeline(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Pipeline obtenido exitosamente', data: { pipeline } });
  } catch (err) {
    next(err);
  }
};

const createPipeline = async (req, res, next) => {
  try {
    const data = await validateBody(createPipelineSchema, req.body);
    const pipeline = await pipelineService.crearPipeline(req.businessId, req.user._id, data);
    return respuestaExito(res, { statusCode: 201, message: 'Pipeline creado exitosamente', data: { pipeline } });
  } catch (err) {
    next(err);
  }
};

const updatePipeline = async (req, res, next) => {
  try {
    const pipeline = await pipelineService.actualizarPipeline(req.businessId, req.params.id, req.body);
    return respuestaExito(res, { message: 'Pipeline actualizado exitosamente', data: { pipeline } });
  } catch (err) {
    next(err);
  }
};

const getBoard = async (req, res, next) => {
  try {
    const { pipeline, tablero } = await pipelineService.obtenerTablero(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Tablero obtenido exitosamente', data: { pipeline, tablero } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getDefault, listPipelines, getPipeline, createPipeline, updatePipeline, getBoard };
