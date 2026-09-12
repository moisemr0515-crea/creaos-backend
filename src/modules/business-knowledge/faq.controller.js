const faqService = require('./faq.service');
const { createFAQSchema, updateFAQSchema, listFAQsSchema } = require('./faq.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11. Ver
// policy.controller.js para el criterio compartido (no se repite acá).
const actor = (req) => ({ _id: req.user._id, name: req.user.name });

const createFAQ = async (req, res, next) => {
  try {
    const data = await validateBody(createFAQSchema, req.body);
    const faq = await faqService.crearFAQ(req.businessId, actor(req), data);
    return respuestaExito(res, { statusCode: 201, message: 'FAQ creada exitosamente', data: { faq } });
  } catch (err) {
    next(err);
  }
};

const getFAQ = async (req, res, next) => {
  try {
    const faq = await faqService.obtenerFAQ(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'FAQ obtenida exitosamente', data: { faq } });
  } catch (err) {
    next(err);
  }
};

const listFAQs = async (req, res, next) => {
  try {
    const filtros = await validateQuery(listFAQsSchema, req.query);
    const { faqs, total } = await faqService.listarFAQs(req.businessId, filtros);
    const { page, limit } = filtros;
    return respuestaExito(res, {
      message: 'FAQs obtenidas exitosamente',
      data: { faqs },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const updateFAQ = async (req, res, next) => {
  try {
    const data = await validateBody(updateFAQSchema, req.body);
    const faq = await faqService.actualizarFAQ(req.businessId, req.params.id, actor(req), data);
    return respuestaExito(res, { message: 'FAQ actualizada exitosamente', data: { faq } });
  } catch (err) {
    next(err);
  }
};

// DELETE /:id NUNCA borra — archiva (status:'archived'). Mismo criterio que
// archivePolicy().
const archiveFAQ = async (req, res, next) => {
  try {
    const faq = await faqService.archivarFAQ(req.businessId, req.params.id, actor(req));
    return respuestaExito(res, { message: 'FAQ archivada exitosamente', data: { faq } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createFAQ,
  getFAQ,
  listFAQs,
  updateFAQ,
  archiveFAQ,
};
