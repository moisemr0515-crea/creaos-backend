const OpenAI = require('openai');
const DailyMission = require('./dailyMission.model');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const { AppError } = require('../../middleware/error.middleware');
const logger = require('../../utils/logger');
const { OPENAI_API_KEY, OPENAI_MODEL } = require('../../config/env');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const MAX_LEADS_POR_LISTA = 5; // cap de leads incluidos en el prompt por categoría (costo de tokens)
const UMBRAL_DIAS_SIN_SEGUIMIENTO = 3;
const UMBRAL_DIAS_ESTANCADO = 7;
const UMBRAL_PROBABILIDAD_CERCA_DE_CERRAR = 60;

// Misiones genéricas de onboarding — se usan cuando el negocio todavía no
// tiene leads (no hay nada real que analizar) o si falla la llamada a
// OpenAI, para nunca devolver un error o una respuesta vacía al frontend.
const MISIONES_FALLBACK = [
  {
    title: 'Completa el perfil de tu negocio',
    description:
      'Agrega la descripción de tu producto, tu cliente ideal y tu ticket promedio en Configuración — así tu agente de IA vende mejor desde el primer día.',
    lead: null,
  },
  {
    title: 'Agrega tus primeros leads',
    description:
      'Importa tus contactos desde un CSV o agrégalos manualmente para empezar a construir tu pipeline de ventas.',
    lead: null,
  },
  {
    title: 'Conecta tu WhatsApp Business',
    description:
      'Vincula tu número de WhatsApp para que tu agente de IA pueda responder a tus clientes automáticamente, 24/7.',
    lead: null,
  },
];

const diasDesde = (fecha) => {
  if (!fecha) return null;
  return Math.floor((Date.now() - new Date(fecha).getTime()) / (1000 * 60 * 60 * 24));
};

/**
 * Fecha calendario de "hoy" en la zona horaria del negocio, como 'YYYY-MM-DD'.
 * Se usa 'en-CA' porque es el locale más simple que formatea nativamente en
 * ese orden (año-mes-día) sin tener que armar el string a mano.
 */
const obtenerFechaDeHoy = (timezone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'America/Mexico_City' }).format(new Date());
  } catch {
    // Timezone inválido/corrupto en el negocio — no debe romper la feature
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  }
};

/**
 * Mapa { pipelineId: { stageKey: {isWon, isLost} } } de todos los pipelines
 * activos del negocio, para poder excluir leads ya cerrados (won/lost) de
 * las listas de "sin seguimiento"/"estancados" sin asumir keys fijas de
 * stage (los pipelines son personalizables por negocio).
 */
const construirMapaDeStages = async (businessId) => {
  const pipelines = await Pipeline.find({ business: businessId, isActive: true }).select('stages');
  const mapa = new Map();
  for (const pipeline of pipelines) {
    const stagesPorKey = new Map(pipeline.stages.map((s) => [s.key, { isWon: s.isWon, isLost: s.isLost }]));
    mapa.set(pipeline._id.toString(), stagesPorKey);
  }
  return mapa;
};

const esLeadCerrado = (lead, mapaDeStages) => {
  const stagesDelPipeline = mapaDeStages.get(lead.pipeline?.toString());
  const config = stagesDelPipeline?.get(lead.pipelineStage);
  return Boolean(config?.isWon || config?.isLost);
};

/**
 * Recopila datos reales del negocio (conteo por temperatura, leads sin
 * seguimiento, leads estancados en su etapa, oportunidades cerca de
 * cerrarse) para darle contexto real a GPT-4o en vez de pedirle consejos
 * genéricos de industria.
 */
const recopilarDatosDeLeads = async (businessId) => {
  const [leadsActivos, mapaDeStages] = await Promise.all([
    Lead.find({ business: businessId, isDeleted: false, isArchived: false }).select(
      'name company temperature pipelineStage pipeline stageChangedAt lastContactedAt createdAt potentialValue currency closeProbability'
    ),
    construirMapaDeStages(businessId),
  ]);

  const leadsAbiertos = leadsActivos.filter((lead) => !esLeadCerrado(lead, mapaDeStages));

  const porTemperatura = { cold: 0, warm: 0, hot: 0 };
  leadsActivos.forEach((lead) => {
    if (porTemperatura[lead.temperature] !== undefined) porTemperatura[lead.temperature] += 1;
  });

  const sinSeguimiento = leadsAbiertos
    .map((lead) => ({ lead, dias: diasDesde(lead.lastContactedAt || lead.createdAt) }))
    .filter(({ dias }) => dias !== null && dias >= UMBRAL_DIAS_SIN_SEGUIMIENTO)
    .sort((a, b) => b.dias - a.dias)
    .slice(0, MAX_LEADS_POR_LISTA);

  const estancados = leadsAbiertos
    .map((lead) => ({ lead, dias: diasDesde(lead.stageChangedAt || lead.createdAt) }))
    .filter(({ dias }) => dias !== null && dias >= UMBRAL_DIAS_ESTANCADO)
    .sort((a, b) => b.dias - a.dias)
    .slice(0, MAX_LEADS_POR_LISTA);

  const cercaDeCerrar = leadsAbiertos
    .filter((lead) => (lead.closeProbability || 0) >= UMBRAL_PROBABILIDAD_CERCA_DE_CERRAR)
    .sort((a, b) => (b.closeProbability || 0) - (a.closeProbability || 0))
    .slice(0, MAX_LEADS_POR_LISTA)
    // Misma forma { lead, dias } que sinSeguimiento/estancados, para que
    // formatearListaLeads() y el cálculo de idsValidos en generarMisiones()
    // puedan tratar las 3 listas de forma uniforme (dias queda null aquí,
    // no se usa en su formateador).
    .map((lead) => ({ lead, dias: null }));

  return {
    totalLeads: leadsActivos.length,
    totalLeadsAbiertos: leadsAbiertos.length,
    porTemperatura,
    sinSeguimiento,
    estancados,
    cercaDeCerrar,
  };
};

// Cada línea del prompt incluye el _id real del lead entre corchetes, para
// que si GPT-4o referencia un lead en una misión, use un id que existe de
// verdad — validamos eso más abajo en parsearRespuestaIA (fail-closed).
const formatearListaLeads = (items, extra) =>
  items
    .map(({ lead, dias }) => `- [${lead._id}] ${lead.name}${lead.company ? ` (${lead.company})` : ''} — ${extra(lead, dias)}`)
    .join('\n') || '(ninguno)';

const construirPromptDatos = (business, datos) => {
  const infoNegocio = [
    business.productDescription && `- Qué vende: ${business.productDescription}`,
    business.industry && `- Rubro: ${business.industry}`,
    business.targetCustomer && `- Cliente ideal: ${business.targetCustomer}`,
  ]
    .filter(Boolean)
    .join('\n');

  return `NEGOCIO: ${business.name}
${infoNegocio ? `${infoNegocio}\n` : ''}
LEADS POR TEMPERATURA: ${datos.porTemperatura.hot} calientes, ${datos.porTemperatura.warm} tibios, ${datos.porTemperatura.cold} fríos (de ${datos.totalLeadsAbiertos} leads abiertos, ${datos.totalLeads} en total).

LEADS SIN SEGUIMIENTO (más de ${UMBRAL_DIAS_SIN_SEGUIMIENTO} días sin contacto):
${formatearListaLeads(datos.sinSeguimiento, (lead, dias) => `${dias} días sin contacto, temperatura ${lead.temperature}`)}

LEADS ESTANCADOS (más de ${UMBRAL_DIAS_ESTANCADO} días en la misma etapa del pipeline):
${formatearListaLeads(datos.estancados, (lead, dias) => `${dias} días en "${lead.pipelineStage}"`)}

OPORTUNIDADES CERCA DE CERRAR (probabilidad de cierre ≥ ${UMBRAL_PROBABILIDAD_CERCA_DE_CERRAR}%):
${formatearListaLeads(datos.cercaDeCerrar, (lead) => `${lead.closeProbability}% de probabilidad${lead.potentialValue ? `, $${lead.potentialValue} ${lead.currency || 'USD'}` : ''}`)}`;
};

const SYSTEM_PROMPT = `Eres un coach de ventas experto que genera la "Misión del Día" para el dueño de un pequeño negocio dentro de un CRM. Tu trabajo es proponer exactamente 3 misiones ACCIONABLES y ESPECÍFICAS para hoy, basadas ÚNICAMENTE en los datos reales de leads que se te dan — nunca des consejos genéricos de industria ("mejora tu marketing", "haz seguimiento a tus clientes") si hay datos concretos disponibles para ser específico (nombres de leads, días de inactividad, etapas, probabilidades).

Si una misión se refiere a un lead puntual de las listas dadas, usa exactamente el _id entre corchetes que aparece junto a ese lead como "leadId". Si la misión es general (no apunta a un lead específico), usa "leadId": null. Nunca inventes un _id que no esté en las listas.

Responde ÚNICAMENTE con JSON válido en este formato exacto:
{
  "missions": [
    { "title": "<máx 12 palabras>", "description": "<1-2 oraciones, accionable>", "leadId": "<_id o null>" },
    { "title": "...", "description": "...", "leadId": null },
    { "title": "...", "description": "...", "leadId": null }
  ]
}`;

/**
 * Valida y normaliza la respuesta de GPT-4o: exactamente 3 misiones con
 * título/descripción, y `leadId` solo se acepta si corresponde a uno de los
 * leads realmente incluidos en el prompt (fail-closed contra alucinaciones).
 */
const parsearRespuestaIA = (contenidoJSON, idsValidos) => {
  let parsed;
  try {
    parsed = JSON.parse(contenidoJSON);
  } catch {
    throw new Error('Respuesta de IA no es JSON válido');
  }

  const misiones = parsed?.missions;
  if (!Array.isArray(misiones) || misiones.length !== 3) {
    throw new Error('La IA no devolvió exactamente 3 misiones');
  }

  return misiones.map((m) => {
    if (!m.title || !m.description) throw new Error('Misión sin title/description');
    const leadId = m.leadId && idsValidos.has(String(m.leadId)) ? m.leadId : null;
    return {
      title: String(m.title).slice(0, 150),
      description: String(m.description).slice(0, 500),
      lead: leadId,
    };
  });
};

/**
 * Genera las 3 misiones del día: si el negocio no tiene leads todavía, o si
 * falla la llamada a OpenAI (rate limit, red, JSON inválido), cae al set
 * genérico de onboarding — nunca deja al frontend sin misiones ni con error.
 */
const generarMisiones = async (business) => {
  const datos = await recopilarDatosDeLeads(business._id);

  if (datos.totalLeads === 0) {
    return { missions: MISIONES_FALLBACK, source: 'fallback' };
  }

  const idsValidos = new Set(
    [...datos.sinSeguimiento, ...datos.estancados, ...datos.cercaDeCerrar].map(({ lead }) => lead._id.toString())
  );

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: construirPromptDatos(business, datos) },
      ],
      max_tokens: 600,
      temperature: 0.6,
      response_format: { type: 'json_object' },
    });

    const missions = parsearRespuestaIA(completion.choices[0].message.content, idsValidos);
    return { missions, source: 'ai' };
  } catch (error) {
    logger.warn(`No se pudo generar Misión del Día con IA para negocio ${business._id}, se usa fallback: ${error.message}`);
    return { missions: MISIONES_FALLBACK, source: 'fallback' };
  }
};

const generarYGuardarMisionDeHoy = async (business, fecha) => {
  const { missions, source } = await generarMisiones(business);

  return DailyMission.findOneAndUpdate(
    { business: business._id, date: fecha },
    { business: business._id, date: fecha, missions, source, generatedAt: new Date() },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
};

const obtenerNegocioOFallar = async (businessId) => {
  const business = await Business.findById(businessId);
  if (!business) throw new AppError('Negocio no encontrado', 404);
  return business;
};

/**
 * GET /missions/today — devuelve el DailyMission cacheado de hoy si ya
 * existe; si no, lo genera, guarda y devuelve (primer acceso del día).
 */
const obtenerMisionDeHoy = async (businessId) => {
  const business = await obtenerNegocioOFallar(businessId);
  const fecha = obtenerFechaDeHoy(business.settings?.timezone);

  const existente = await DailyMission.findOne({ business: businessId, date: fecha });
  if (existente) return existente;

  return generarYGuardarMisionDeHoy(business, fecha);
};

/**
 * POST /missions/regenerate — siempre genera un set nuevo para hoy y
 * sobrescribe el cache existente del día (upsert sobre el mismo índice
 * único business+date, no crea un documento duplicado).
 */
const regenerarMisionDeHoy = async (businessId) => {
  const business = await obtenerNegocioOFallar(businessId);
  const fecha = obtenerFechaDeHoy(business.settings?.timezone);

  return generarYGuardarMisionDeHoy(business, fecha);
};

module.exports = {
  obtenerMisionDeHoy,
  regenerarMisionDeHoy,
  // Exportado para tests/depuración — no usado por el controller directamente.
  obtenerFechaDeHoy,
  recopilarDatosDeLeads,
  generarMisiones,
};
