const service = require('./automation.service');
const { createAutomationSchema, updateAutomationSchema, listAutomationsSchema } = require('./automation.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');

const create = async (req, res, next) => {
  try {
    const data         = await validateBody(createAutomationSchema, req.body);
    const automation   = await service.createAutomation(req.businessId, data, req.user._id);
    return respuestaExito(res, { statusCode: 201, message: 'Automatización creada exitosamente', data: { automation } });
  } catch (err) { next(err); }
};

const list = async (req, res, next) => {
  try {
    const filters                = await validateQuery(listAutomationsSchema, req.query);
    const { automations, total } = await service.listAutomations(req.businessId, filters);
    return respuestaExito(res, {
      message: 'Automatizaciones obtenidas exitosamente',
      data:    { automations },
      meta:    buildMeta({ page: filters.page, limit: filters.limit, total }),
    });
  } catch (err) { next(err); }
};

const get = async (req, res, next) => {
  try {
    const automation = await service.getAutomationById(req.businessId, req.params.automationId);
    return respuestaExito(res, { message: 'Automatización obtenida exitosamente', data: { automation } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const data       = await validateBody(updateAutomationSchema, req.body);
    const automation = await service.updateAutomation(req.businessId, req.params.automationId, data);
    return respuestaExito(res, { message: 'Automatización actualizada exitosamente', data: { automation } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    await service.deleteAutomation(req.businessId, req.params.automationId);
    return respuestaExito(res, { message: 'Automatización eliminada exitosamente', data: null });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const result = await service.toggleActive(req.businessId, req.params.automationId);
    return respuestaExito(res, {
      message: `Automatización ${result.isActive ? 'activada' : 'desactivada'} exitosamente`,
      data:    result,
    });
  } catch (err) { next(err); }
};

const getLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { logs, total }          = await service.getAutomationLogs(req.businessId, req.params.automationId, page, limit);
    return respuestaExito(res, {
      message: 'Logs obtenidos exitosamente',
      data:    { logs },
      meta:    buildMeta({ page, limit, total }),
    });
  } catch (err) { next(err); }
};

const test = async (req, res, next) => {
  try {
    const { leadId } = req.body;
    if (!leadId) {
      const { AppError } = require('../../middleware/error.middleware');
      throw new AppError('leadId es requerido para probar la automatización', 400);
    }
    const result = await service.testAutomation(req.businessId, req.params.automationId, leadId);
    return respuestaExito(res, { message: result.message, data: result });
  } catch (err) { next(err); }
};

module.exports = { create, list, get, update, remove, toggle, getLogs, test };
