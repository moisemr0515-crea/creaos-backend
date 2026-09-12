const Policy = require('./policy.model');
const Product = require('../products/product.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 3/11
// (CRUD con hard filters de tenant — el retrieval para la IA, con
// vigencia/scope/ranking, vive aparte en knowledgeRetrieval.service.js).
// Mismas convenciones que product.service.js: `business` siempre
// explícito en cada query, nunca "por convención".

/**
 * Documento §6.2 regla 10: las referencias de `scope` deben pertenecer al
 * mismo negocio — se valida acá (service), no en el schema, mismo
 * criterio que crearLead() valida `assignedTo` contra el negocio antes de
 * guardar. `WhatsAppChannel` tiene tanto `tenantId` como `businessId`
 * (hoy synónimos, ver whatsappChannel.model.js) — se filtra por
 * `businessId`, el nombre que corresponde a lo que se está validando acá.
 */
const validarScope = async (businessId, scope) => {
  if (!scope) return;

  if (scope.productIds?.length) {
    const count = await Product.countDocuments({ _id: { $in: scope.productIds }, business: businessId });
    if (count !== scope.productIds.length) {
      throw new AppError('Uno o más productos de scope.productIds no pertenecen a este negocio', 400);
    }
  }

  if (scope.channelIds?.length) {
    const count = await WhatsAppChannel.countDocuments({ _id: { $in: scope.channelIds }, businessId });
    if (count !== scope.channelIds.length) {
      throw new AppError('Uno o más canales de scope.channelIds no pertenecen a este negocio', 400);
    }
  }
};

const verificarCodeDuplicado = async (businessId, code, { excluirPolicyId } = {}) => {
  const filtro = { business: businessId, code: code.trim().toUpperCase() };
  if (excluirPolicyId) filtro._id = { $ne: excluirPolicyId };

  const existente = await Policy.findOne(filtro);
  if (existente) {
    throw new AppError(`Ya existe una Policy con el code "${existente.code}" en este negocio: ${existente.title}`, 409);
  }
};

const crearPolicy = async (businessId, actor, data) => {
  await verificarCodeDuplicado(businessId, data.code);
  await validarScope(businessId, data.scope);

  const policy = new Policy({
    ...data,
    business: businessId,
    createdBy: actor?._id ?? null,
    updatedBy: actor?._id ?? null,
  });

  await policy.save();
  return policy;
};

/**
 * Sin filtro de status/vigencia a propósito — es la vista de
 * administración (puede/debe poder ver una Policy en draft o archivada
 * para editarla). El filtro "solo elegible para responder al cliente"
 * vive exclusivamente en knowledgeRetrieval.service.js — mismo criterio
 * que obtenerProducto() (cualquier estado) vs. obtenerProductoActivo()
 * (solo activos) en Product Intelligence.
 */
const obtenerPolicy = async (businessId, policyId) => {
  const policy = await Policy.findOne({ _id: policyId, business: businessId });
  if (!policy) throw new AppError('Policy no encontrada', 404);
  return policy;
};

const listarPolicies = async (businessId, filtros = {}) => {
  const { page = 1, limit = 20, search, category, status } = filtros;
  const skip = (Number(page) - 1) * Number(limit);

  const query = { business: businessId };
  if (category) query.category = category;
  if (status) query.status = status;
  if (search) query.$text = { $search: search };

  const [policies, total] = await Promise.all([
    Policy.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { priority: -1, createdAt: -1 })
      .select(search ? { score: { $meta: 'textScore' } } : {})
      .skip(skip)
      .limit(Number(limit)),
    Policy.countDocuments(query),
  ]);

  return { policies, total };
};

// Documento §6.2 regla 12: "cambios relevantes incrementan version" — qué
// cuenta como relevante es una decisión de negocio, no de schema (por eso
// vive acá, no en policy.model.js). Tocar el contenido real que la IA
// usaría para responder incrementa version; metadata administrativa
// (tags, code) no.
const CAMPOS_QUE_INCREMENTAN_VERSION = ['statement', 'customerFacingText', 'category', 'policyType', 'scope', 'action', 'effectiveFrom', 'effectiveUntil'];

const actualizarPolicy = async (businessId, policyId, actor, data) => {
  const policy = await obtenerPolicy(businessId, policyId);

  if (data.code !== undefined && data.code.trim().toUpperCase() !== policy.code) {
    await verificarCodeDuplicado(businessId, data.code, { excluirPolicyId: policy._id });
  }
  if (data.scope !== undefined) {
    await validarScope(businessId, data.scope);
  }

  const huboContenidoRelevante = CAMPOS_QUE_INCREMENTAN_VERSION.some((campo) => data[campo] !== undefined);

  Object.assign(policy, data);
  policy.updatedBy = actor?._id ?? null;
  if (huboContenidoRelevante) policy.version += 1;

  await policy.save();
  return policy;
};

/**
 * "Eliminar" una Policy es SIEMPRE archivarla (documento §6.2 regla 8,
 * §29: "archivar en lugar de borrar") — nunca un borrado real. Mismo
 * criterio que desactivarProducto() en Product Intelligence.
 */
const archivarPolicy = async (businessId, policyId, actor) => {
  const policy = await obtenerPolicy(businessId, policyId);
  policy.status = 'archived';
  policy.updatedBy = actor?._id ?? null;
  await policy.save();
  return policy;
};

module.exports = {
  crearPolicy,
  obtenerPolicy,
  listarPolicies,
  actualizarPolicy,
  archivarPolicy,
};
