const leadService = require('./lead.service');
const {
  createLeadSchema,
  updateLeadSchema,
  addNoteSchema,
  changeStageSchema,
  assignLeadSchema,
  listLeadsSchema,
  bulkActionSchema,
} = require('./lead.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');

const actor = (req) => ({ _id: req.user._id, name: req.user.name });

// SALES tiene leads:read + leads:own → leads:own restringe a propios
const soloVePropios = (user) => {
  const perms = user.role?.permissions || [];
  return user.role?.slug !== 'superadmin' && perms.includes('leads:own');
};

const createLead = async (req, res, next) => {
  try {
    const data = await validateBody(createLeadSchema, req.body);
    const lead = await leadService.crearLead(req.businessId, actor(req), data);
    return respuestaExito(res, { statusCode: 201, message: 'Lead creado exitosamente', data: { lead } });
  } catch (err) {
    next(err);
  }
};

const getLead = async (req, res, next) => {
  try {
    const lead = await leadService.obtenerLead(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Lead obtenido exitosamente', data: { lead } });
  } catch (err) {
    next(err);
  }
};

const listLeads = async (req, res, next) => {
  try {
    const filtros = await validateQuery(listLeadsSchema, req.query);
    const ownOnly = soloVePropios(req.user);
    const { leads, total } = await leadService.listarLeads(req.businessId, filtros, req.user._id, ownOnly);
    const { page, limit } = filtros;
    return respuestaExito(res, {
      message: 'Leads obtenidos exitosamente',
      data: { leads },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const updateLead = async (req, res, next) => {
  try {
    const data = await validateBody(updateLeadSchema, req.body);
    const lead = await leadService.actualizarLead(req.businessId, req.params.id, actor(req), data);
    return respuestaExito(res, { message: 'Lead actualizado exitosamente', data: { lead } });
  } catch (err) {
    next(err);
  }
};

const deleteLead = async (req, res, next) => {
  try {
    await leadService.eliminarLead(req.businessId, req.params.id, actor(req));
    return respuestaExito(res, { message: 'Lead eliminado exitosamente' });
  } catch (err) {
    next(err);
  }
};

const addNote = async (req, res, next) => {
  try {
    const { content } = await validateBody(addNoteSchema, req.body);
    const nota = await leadService.agregarNota(req.businessId, req.params.id, actor(req), content);
    return respuestaExito(res, { statusCode: 201, message: 'Nota agregada exitosamente', data: { nota } });
  } catch (err) {
    next(err);
  }
};

const changeStage = async (req, res, next) => {
  try {
    const { stage, reason } = await validateBody(changeStageSchema, req.body);
    const lead = await leadService.cambiarEtapa(req.businessId, req.params.id, actor(req), stage, reason);
    return respuestaExito(res, { message: 'Etapa actualizada exitosamente', data: { lead } });
  } catch (err) {
    next(err);
  }
};

const assignLead = async (req, res, next) => {
  try {
    const { assignedTo } = await validateBody(assignLeadSchema, req.body);
    const lead = await leadService.asignarLead(req.businessId, req.params.id, actor(req), assignedTo);
    return respuestaExito(res, { message: 'Lead asignado exitosamente', data: { lead } });
  } catch (err) {
    next(err);
  }
};

const bulkAction = async (req, res, next) => {
  try {
    const data = await validateBody(bulkActionSchema, req.body);
    const resultado = await leadService.accionMasiva(req.businessId, actor(req), data);
    return respuestaExito(res, { message: 'Acción masiva completada', data: resultado });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createLead,
  getLead,
  listLeads,
  updateLead,
  deleteLead,
  addNote,
  changeStage,
  assignLead,
  bulkAction,
};
