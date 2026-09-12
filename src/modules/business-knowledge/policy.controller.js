const policyService = require('./policy.service');
const { createPolicySchema, updatePolicySchema, listPoliciesSchema } = require('./policy.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11 (CRUD
// API + RBAC). Mismo patrón exacto que product.controller.js —
// `req.businessId` viene SIEMPRE de injectTenant (policy.routes.js), nunca
// de req.body/req.query.
const actor = (req) => ({ _id: req.user._id, name: req.user.name });

const createPolicy = async (req, res, next) => {
  try {
    const data = await validateBody(createPolicySchema, req.body);
    const policy = await policyService.crearPolicy(req.businessId, actor(req), data);
    return respuestaExito(res, { statusCode: 201, message: 'Policy creada exitosamente', data: { policy } });
  } catch (err) {
    next(err);
  }
};

const getPolicy = async (req, res, next) => {
  try {
    const policy = await policyService.obtenerPolicy(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Policy obtenida exitosamente', data: { policy } });
  } catch (err) {
    next(err);
  }
};

const listPolicies = async (req, res, next) => {
  try {
    const filtros = await validateQuery(listPoliciesSchema, req.query);
    const { policies, total } = await policyService.listarPolicies(req.businessId, filtros);
    const { page, limit } = filtros;
    return respuestaExito(res, {
      message: 'Policies obtenidas exitosamente',
      data: { policies },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const updatePolicy = async (req, res, next) => {
  try {
    const data = await validateBody(updatePolicySchema, req.body);
    const policy = await policyService.actualizarPolicy(req.businessId, req.params.id, actor(req), data);
    return respuestaExito(res, { message: 'Policy actualizada exitosamente', data: { policy } });
  } catch (err) {
    next(err);
  }
};

// DELETE /:id NUNCA borra — archiva (status:'archived'). Mismo criterio que
// deactivateProduct() en product.controller.js.
const archivePolicy = async (req, res, next) => {
  try {
    const policy = await policyService.archivarPolicy(req.businessId, req.params.id, actor(req));
    return respuestaExito(res, { message: 'Policy archivada exitosamente', data: { policy } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createPolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  archivePolicy,
};
