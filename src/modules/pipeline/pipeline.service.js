const Pipeline = require('./pipeline.model');
const Lead = require('../leads/lead.model');
// De lead.search.js, NO de lead.service.js — lead.service.js ya requiere
// este mismo pipeline.service.js (obtenerPipelineEfectivo/
// validarStageEnPipeline), así que importar aplicarFiltroDeBusqueda desde
// ahí cerraría un ciclo real. Ver el comentario en lead.search.js.
const { aplicarFiltroDeBusqueda } = require('../leads/lead.search');
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

// Cuántos leads trae cada columna en la carga inicial del tablero — el
// resto se pide bajo demanda vía GET /leads?stage=X&pipeline=Y&page=N
// (listarLeads(), ya paginado; ver "ver más" en el frontend, backlog
// "buscador + paginación real del Kanban", PR D/5). No hace falta que
// esta función soporte skip/página — solo el primer corte fijo.
const CORTE_INICIAL_POR_COLUMNA = 7;

// Mismo criterio que probability() (crea-os-ignite, src/lib/lead-finance.ts)
// — portado a una expresión de aggregate para poder promediarlo sobre
// TODOS los leads activos de la columna (no solo los primeros 7 visibles)
// sin traer los documentos completos al cliente. `$ifNull` cubre tanto
// "campo ausente" como "campo null" con el mismo camino (igual que el
// `!= null` de la versión JS). Fallback por temperatura si no hay
// closeProbability explícito: cold:10, warm:40, hot:75, default 20 —
// deben mantenerse sincronizados a mano con FALLBACK en lead-finance.ts.
const EXPR_PROBABILIDAD = {
  $cond: [
    { $eq: [{ $ifNull: ['$closeProbability', null] }, null] },
    {
      $switch: {
        branches: [
          { case: { $eq: ['$temperature', 'cold'] }, then: 10 },
          { case: { $eq: ['$temperature', 'warm'] }, then: 40 },
          { case: { $eq: ['$temperature', 'hot'] }, then: 75 },
        ],
        default: 20,
      },
    },
    { $min: [100, { $max: [0, '$closeProbability'] }] },
  ],
};

/**
 * `search` opcional (mismo criterio que /leads — name/email/company por
 * $text, phone por $regex de substring, ver lead.search.js) filtra qué
 * leads entran al tablero antes de agruparlos por stage.
 *
 * `leads` de cada columna viene cortado a los primeros
 * CORTE_INICIAL_POR_COLUMNA (por `createdAt` desc) vía el acumulador
 * `$topN` — soportado desde Mongo 5.2+, verificado en los 2 entornos reales
 * de este proyecto antes de elegirlo (local 7.0.37, Atlas prod 8.0.32).
 * `count`/`totalValue`/`avgCloseProbability` siguen calculándose sobre
 * TODOS los leads de la columna (no solo los 7 visibles) — son acumuladores
 * aparte dentro del mismo `$group`, no dependen del array cortado.
 * `hasMore` (`count > leads.length`) le ahorra al frontend recalcularlo.
 */
const obtenerTablero = async (businessId, pipelineId, search) => {
  const pipeline = await obtenerPipeline(businessId, pipelineId);

  const query = {
    business: pipeline.business,
    // Incidente de producción (11/sep/2026): la mayoría de los caminos de
    // creación AUTOMÁTICA de leads (WhatsApp entrante — processGupshupMessage(),
    // el que corre tráfico real hoy, ads, automatizaciones — ver
    // docs/implementation/known-issues.md) nunca seteaban `pipeline`. Un
    // `pipeline: pipeline._id` estricto acá los excluía del tablero por
    // completo y en silencio — confirmado con datos reales: 11 leads
    // huérfanos en 3 de los 5 negocios reales con actividad. Se trata un
    // lead SIN el campo `pipeline` seteado como perteneciente al pipeline
    // que se está pidiendo — seguro hoy porque ningún negocio real tiene
    // más de un pipeline activo (verificado contra producción antes de
    // este fix). Permanente, no un parche temporal: aunque el backfill
    // (script aparte) y el fix hacia adelante en los puntos de creación
    // cierren el problema de raíz, esto queda como red de seguridad barata
    // ante cualquier camino futuro que se olvide de setear `pipeline`.
    $or: [
      { pipeline: pipeline._id },
      { pipeline: { $exists: false } },
    ],
    isDeleted: false,
    isArchived: false,
  };

  if (search) {
    await aplicarFiltroDeBusqueda(query, search);
  }

  const grupos = await Lead.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$pipelineStage',
        leads: {
          $topN: {
            output: {
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
              // Necesario para la alerta "sin respuesta hace Nh" de la
              // tarjeta del Kanban (crea-os-ignite, pipeline.tsx) — faltaba
              // en la proyección original de este PR, encontrado al migrar
              // el frontend a este endpoint (backlog "buscador + paginación
              // real del Kanban", PR D/5).
              lastContactedAt: '$lastContactedAt',
            },
            sortBy: { createdAt: -1 },
            n: CORTE_INICIAL_POR_COLUMNA,
          },
        },
        count: { $sum: 1 },
        totalValue: { $sum: '$potentialValue' },
        avgCloseProbability: { $avg: EXPR_PROBABILIDAD },
      },
    },
  ]);

  const tablero = pipeline.stages.map((stage) => {
    const grupo = grupos.find((g) => g._id === stage.key) || { leads: [], count: 0, totalValue: 0, avgCloseProbability: 0 };
    return {
      stage: stage.key,
      name: stage.name,
      color: stage.color,
      order: stage.order,
      isWon: stage.isWon,
      isLost: stage.isLost,
      count: grupo.count,
      totalValue: grupo.totalValue,
      avgCloseProbability: Math.round(grupo.avgCloseProbability ?? 0),
      hasMore: grupo.count > grupo.leads.length,
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
