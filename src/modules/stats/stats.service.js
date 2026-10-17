const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Sale = require('../sales/sale.model');
const { EXPR_PROBABILIDAD } = require('../pipeline/pipeline.service');
const { normalizarMoneda } = require('../../utils/money');
const { esZonaValida } = require('../../utils/timezone');
const { AppError } = require('../../middleware/error.middleware');
const { resolverPeriodo } = require('./stats.period');

// Sin zona horaria configurada (país fuera de la tabla) no se inventa ninguna: UTC, y la respuesta lo avisa.
const ZONA_SIN_CONFIGURAR = 'UTC';
const UMBRAL_LISTO_PARA_CERRAR = 70; // mismo criterio que la pantalla: "caliente" o probabilidad >= 70
const TOP = 5;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Condición de etapa por pipeline, SIN casos fijos: cada lead se mira contra las etapas ganada/perdida del pipeline que
 * tiene. Un lead sin pipeline (o con uno inactivo) cuenta como del pipeline por defecto, igual que obtenerPipelineEfectivo()
 * (pero sin crearlo: esto es una lectura). Si el negocio aún no tiene ningún pipeline, valen las etapas por defecto.
 *   tipo 'ganado'  → leads en una etapa isWon
 *   tipo 'abierto' → leads que NO están en una etapa isWon ni isLost
 */
const condicionDeEtapas = (pipelines, tipo) => {
  const lista = pipelines.length ? pipelines : [{ _id: null, isDefault: true, stages: Pipeline.DEFAULT_STAGES }];
  const idsActivos = pipelines.map((p) => p._id);
  const porDefecto = lista.find((p) => p.isDefault) || lista[0];

  const claves = (p) => p.stages.filter((s) => (tipo === 'ganado' ? s.isWon : s.isWon || s.isLost)).map((s) => s.key);
  const etapa = (p) => (tipo === 'ganado' ? { $in: claves(p) } : { $nin: claves(p) });

  const clausulas = pipelines.map((p) => ({ pipeline: p._id, pipelineStage: etapa(p) }));
  // `$nin` también acepta leads sin campo `pipeline` o con null.
  clausulas.push({ pipeline: { $nin: idsActivos }, pipelineStage: etapa(porDefecto) });
  return { $or: clausulas };
};

const redondear2 = (n) => Math.round(n * 100) / 100;

// Agrupa ventas por moneda. `currency` null = ventas de un negocio que no tenía moneda definida: se muestran aparte, no se mezclan.
const ventasPorMoneda = async (negocioOid, filtro) => {
  const filas = await Sale.aggregate([
    { $match: { business: negocioOid, ...filtro } },
    { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 }, ultimaVenta: { $max: '$closedAt' } } },
  ]);
  return new Map(filas.map((f) => [f._id ?? null, f]));
};

/**
 * Resumen de Estadísticas de UN negocio y un periodo. `businessId` sale siempre del token. Todo se calcula en el servidor
 * (sin el tope de 20 leads de la lista) y solo de ESTE negocio.
 *
 *   vendido          ventas CONFIRMADAS con monto > 0 cerradas en el periodo (por `closedAt`), por moneda, con el periodo anterior.
 *   porConfirmar     ventas pendientes (de cualquier fecha: es trabajo por resolver, no del periodo).
 *   sinMonto         pendiente de registrar monto, de cualquier fecha: ganados sin ninguna venta confirmada + ventas confirmadas en 0.
 *   enConversaciones leads abiertos (estimado, en la moneda del negocio): total potencial, valor esperado, listos para cerrar y top 5.
 *   contadores       Leads, Calientes, Cerrados, tasa de cierre y cierre promedio, de TODO el historial (no del periodo), con las
 *                    mismas definiciones que la pantalla calculaba con los 20 leads más recientes (ver `contadores` más abajo).
 */
const obtenerResumen = async (businessId, query = {}, { ahora = new Date() } = {}) => {
  const negocio = await Business.findById(businessId, 'currency settings.timezone').lean();
  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  const zonaConfigurada = esZonaValida(negocio.settings?.timezone) ? negocio.settings.timezone : null;
  const zona = zonaConfigurada || ZONA_SIN_CONFIGURAR;
  const periodo = resolverPeriodo(query, zona, ahora);

  const negocioOid = new mongoose.Types.ObjectId(businessId);
  const pipelines = await Pipeline.find({ business: negocioOid, isActive: true }, '_id isDefault stages.key stages.isWon stages.isLost').lean();
  const condGanado = condicionDeEtapas(pipelines, 'ganado');
  const condAbierto = condicionDeEtapas(pipelines, 'abierto');

  const confirmadasEn = ({ desde, hasta }) => ({ status: 'confirmed', amount: { $gt: 0 }, closedAt: { $gte: desde, $lt: hasta } });

  const baseActivos = { business: negocioOid, isDeleted: false, isArchived: false };

  const [actual, anterior, pendientes, ventasEnCero, ganadosSinVenta, abiertos, totalActivos, cerradosYCierre] = await Promise.all([
    ventasPorMoneda(negocioOid, confirmadasEn(periodo)),
    ventasPorMoneda(negocioOid, confirmadasEn(periodo.anterior)),
    ventasPorMoneda(negocioOid, { status: 'pending' }),
    Sale.countDocuments({ business: negocioOid, status: 'confirmed', amount: 0 }),
    Lead.aggregate([
      { $match: { business: negocioOid, isDeleted: false, ...condGanado } },
      { $lookup: { from: Sale.collection.name, localField: '_id', foreignField: 'lead', pipeline: [{ $match: { business: negocioOid, status: 'confirmed' } }, { $limit: 1 }], as: 'ventas' } },
      { $match: { ventas: { $size: 0 } } },
      { $count: 'n' },
    ]),
    Lead.aggregate([
      { $match: { business: negocioOid, isDeleted: false, isArchived: false, ...condAbierto } },
      { $addFields: { _valor: { $ifNull: ['$potentialValue', 0] }, _prob: EXPR_PROBABILIDAD } },
      // Mismo redondeo que la pantalla (Math.round: la mitad sube).
      { $addFields: { _esperado: { $floor: { $add: [{ $divide: [{ $multiply: ['$_valor', '$_prob'] }, 100] }, 0.5] } } } },
      {
        $facet: {
          resumen: [{
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalPotencial: { $sum: '$_valor' },
              valorEsperado: { $sum: '$_esperado' },
              listosParaCerrar: { $sum: { $cond: [{ $or: [{ $eq: ['$temperature', 'hot'] }, { $gte: ['$_prob', UMBRAL_LISTO_PARA_CERRAR] }] }, 1, 0] } },
            },
          }],
          top: [
            { $match: { _esperado: { $gt: 0 } } },
            { $sort: { _esperado: -1, createdAt: -1 } },
            { $limit: TOP },
            { $project: { _id: 1, name: 1, temperature: 1, pipelineStage: 1, lastContactedAt: 1, createdAt: 1, valorEstimado: '$_valor', probabilidad: '$_prob', valorEsperado: '$_esperado' } },
          ],
        },
      },
    ]),
    Lead.countDocuments(baseActivos),
    // Cerrados = leads en una etapa ganada de SU pipeline. Cierre promedio = días entre la creación y el último cambio de etapa
    // (`stageChangedAt`, el momento en que llegaron a «ganado»), solo de los que tienen esa fecha; un negativo cuenta como 0.
    // $avg ignora los null: un lead ganado sin stageChangedAt cuenta como cerrado pero no entra al promedio.
    Lead.aggregate([
      { $match: { ...baseActivos, ...condGanado } },
      {
        $group: {
          _id: null,
          cerrados: { $sum: 1 },
          diasPromedio: {
            $avg: {
              $cond: [
                { $and: [{ $ifNull: ['$stageChangedAt', false] }, { $ifNull: ['$createdAt', false] }] },
                { $max: [0, { $divide: [{ $subtract: ['$stageChangedAt', '$createdAt'] }, DIA_MS] }] },
                null,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const monedasVendido = new Set([...actual.keys(), ...anterior.keys()]);
  const porMoneda = [...monedasVendido].map((currency) => {
    const a = actual.get(currency);
    const p = anterior.get(currency);
    return {
      currency,
      total: a?.total ?? 0,
      count: a?.count ?? 0,
      average: a?.count ? redondear2(a.total / a.count) : 0,
      lastSaleAt: a?.ultimaVenta ?? null,
      previous: { total: p?.total ?? 0, count: p?.count ?? 0 },
    };
  }).sort((x, y) => y.total - x.total);

  const ultimas = porMoneda.map((m) => m.lastSaleAt).filter(Boolean);
  const resumenAbiertos = abiertos[0]?.resumen[0];

  return {
    period: {
      key: periodo.key,
      from: periodo.desde.toISOString(),
      to: periodo.hasta.toISOString(), // excluido
      previous: { from: periodo.anterior.desde.toISOString(), to: periodo.anterior.hasta.toISOString() },
      timezone: zona,
      timezoneConfigured: Boolean(zonaConfigurada),
    },
    businessCurrency: normalizarMoneda(negocio.currency) || null,
    vendido: {
      count: porMoneda.reduce((s, m) => s + m.count, 0),
      lastSaleAt: ultimas.length ? new Date(Math.max(...ultimas.map((d) => d.getTime()))) : null,
      porMoneda,
    },
    porConfirmar: {
      count: [...pendientes.values()].reduce((s, f) => s + f.count, 0),
      porMoneda: [...pendientes.entries()].map(([currency, f]) => ({ currency, total: f.total, count: f.count })),
    },
    sinMonto: {
      ganadosSinVenta: ganadosSinVenta[0]?.n ?? 0,
      ventasConMontoCero: ventasEnCero,
      total: (ganadosSinVenta[0]?.n ?? 0) + ventasEnCero,
    },
    enConversaciones: {
      count: resumenAbiertos?.count ?? 0,
      totalPotencial: resumenAbiertos?.totalPotencial ?? 0,
      valorEsperado: resumenAbiertos?.valorEsperado ?? 0,
      listosParaCerrar: resumenAbiertos?.listosParaCerrar ?? 0,
      top: abiertos[0]?.top ?? [],
    },
    contadores: {
      leads: totalActivos,
      calientes: resumenAbiertos?.listosParaCerrar ?? 0,
      cerrados: cerradosYCierre[0]?.cerrados ?? 0,
      tasaDeCierre: totalActivos > 0 ? Math.round(((cerradosYCierre[0]?.cerrados ?? 0) / totalActivos) * 100) : 0,
      // null = no hay ningún lead ganado con fecha de cierre; sin redondear (la pantalla decide cómo mostrarlo).
      cierrePromedioDias: cerradosYCierre[0]?.diasPromedio ?? null,
    },
  };
};

module.exports = { obtenerResumen, condicionDeEtapas };
