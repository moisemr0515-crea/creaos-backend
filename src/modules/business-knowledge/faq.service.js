const FAQ = require('./faq.model');
const Policy = require('./policy.model');
const Product = require('../products/product.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 3/11. Ver
// policy.service.js para las convenciones compartidas (no se repiten acá).

/**
 * Documento §7.1: "linked policies deben pertenecer al tenant" — mismo
 * criterio que validarScope() de policy.service.js, extendido a
 * linkedProductIds (documento §6.2 regla 10, aplicado también a FAQ) y a
 * scope.channelIds (FAQ.scope V1 no tiene productIds propio — ver
 * faq.model.js).
 */
const validarReferencias = async (businessId, { linkedPolicyIds, linkedProductIds, scope } = {}) => {
  if (linkedPolicyIds?.length) {
    const count = await Policy.countDocuments({ _id: { $in: linkedPolicyIds }, business: businessId });
    if (count !== linkedPolicyIds.length) {
      throw new AppError('Una o más Policies de linkedPolicyIds no pertenecen a este negocio', 400);
    }
  }

  if (linkedProductIds?.length) {
    const count = await Product.countDocuments({ _id: { $in: linkedProductIds }, business: businessId });
    if (count !== linkedProductIds.length) {
      throw new AppError('Uno o más productos de linkedProductIds no pertenecen a este negocio', 400);
    }
  }

  if (scope?.channelIds?.length) {
    const count = await WhatsAppChannel.countDocuments({ _id: { $in: scope.channelIds }, businessId });
    if (count !== scope.channelIds.length) {
      throw new AppError('Uno o más canales de scope.channelIds no pertenecen a este negocio', 400);
    }
  }
};

const crearFAQ = async (businessId, actor, data) => {
  await validarReferencias(businessId, data);

  const faq = new FAQ({
    ...data,
    business: businessId,
    createdBy: actor?._id ?? null,
    updatedBy: actor?._id ?? null,
  });

  await faq.save();
  return faq;
};

/** Sin filtro de status/vigencia — vista de administración. Ver la misma nota en policy.service.js#obtenerPolicy(). */
const obtenerFAQ = async (businessId, faqId) => {
  const faq = await FAQ.findOne({ _id: faqId, business: businessId });
  if (!faq) throw new AppError('FAQ no encontrada', 404);
  return faq;
};

const listarFAQs = async (businessId, filtros = {}) => {
  const { page = 1, limit = 20, search, category, status } = filtros;
  const skip = (Number(page) - 1) * Number(limit);

  const query = { business: businessId };
  if (category) query.category = category;
  if (status) query.status = status;
  if (search) query.$text = { $search: search };

  const [faqs, total] = await Promise.all([
    FAQ.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { priority: -1, createdAt: -1 })
      .select(search ? { score: { $meta: 'textScore' } } : {})
      .skip(skip)
      .limit(Number(limit)),
    FAQ.countDocuments(query),
  ]);

  return { faqs, total };
};

const CAMPOS_QUE_INCREMENTAN_VERSION = ['question', 'answer', 'category', 'effectiveFrom', 'effectiveUntil'];

const actualizarFAQ = async (businessId, faqId, actor, data) => {
  const faq = await obtenerFAQ(businessId, faqId);
  await validarReferencias(businessId, data);

  const huboContenidoRelevante = CAMPOS_QUE_INCREMENTAN_VERSION.some((campo) => data[campo] !== undefined);

  Object.assign(faq, data);
  faq.updatedBy = actor?._id ?? null;
  if (huboContenidoRelevante) faq.version += 1;

  await faq.save();
  return faq;
};

/** Nunca borra — mismo criterio que archivarPolicy(). */
const archivarFAQ = async (businessId, faqId, actor) => {
  const faq = await obtenerFAQ(businessId, faqId);
  faq.status = 'archived';
  faq.updatedBy = actor?._id ?? null;
  await faq.save();
  return faq;
};

module.exports = {
  crearFAQ,
  obtenerFAQ,
  listarFAQs,
  actualizarFAQ,
  archivarFAQ,
};
