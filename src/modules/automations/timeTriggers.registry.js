/**
 * Registro de evaluadores de trigger por tiempo (Caso 7 del backlog, PR 2/3).
 *
 * A diferencia de los triggers de evento (lead_created, lead_assigned, etc.
 * — ver automation.model.js#TRIGGER_TYPES), un trigger de tiempo no lo
 * dispara nadie: un job periódico (PR 3/3, automationSweep.worker.js) tiene
 * que preguntarle a Mongo "qué leads de este negocio cumplen la condición
 * de tiempo AHORA" — este módulo es esa traducción, puro y sin I/O: dado un
 * trigger.type + trigger.conditions de una Automation, devuelve el filtro
 * de Mongo que hay que combinarle a {business, isDeleted:false} para
 * encontrar los leads candidatos.
 *
 * Deliberadamente NO toca automation.engine.js — conditionsMet(),
 * evaluateCondition() y runAutomation() siguen sin cambios; ese archivo
 * evalúa condiciones sobre UN lead ya cargado en memoria (el caso de los
 * triggers de evento), mientras que este módulo resuelve la pregunta
 * inversa (qué leads matchean, sin tener ninguno cargado todavía) — son
 * problemas distintos, con código distinto, que en el PR 3 conviven: el
 * sweep usa ESTE módulo para encontrar candidatos, y (según lo dejó
 * documentado el diagnóstico original) puede reusar conditionsMet() sin
 * tocarlo para el recheck final antes de ejecutar.
 *
 * Alcance deliberadamente angosto (a pedido explícito): solo los 2
 * triggers que necesita el Caso 5 hoy. No se agregan triggers de tiempo
 * que nadie pidió todavía — el próximo (si aparece, ver "Follow-up Engine
 * con trigger por tiempo" en implementation-blueprint.md §12) se suma acá
 * mismo, una entrada más en TIME_TRIGGER_FIELDS, sin tocar el resto.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nombre de campo convencional en trigger.conditions para el umbral en
 * días de un trigger de tiempo — ej. { field: 'daysThreshold', operator:
 * 'greater_than', value: 3 }. No es un campo nuevo en el schema de
 * Automation (trigger.conditions ya es un array [{field, operator, value}]
 * de tipo libre, pensado justo para esto desde el PR 1) — es solo la
 * convención de nombre que este registro reconoce.
 *
 * Solo se soporta el operador 'greater_than' ("hace más de N días") — es
 * el único que tiene sentido semántico para "stale"/"estancado". Cualquier
 * otro operador sobre este campo es un error de configuración explícito,
 * no un comportamiento silencioso.
 */
const DAYS_THRESHOLD_FIELD = 'daysThreshold';
const DAYS_THRESHOLD_OPERATOR = 'greater_than';

/**
 * Por cada trigger de tiempo soportado: sobre qué campo real de Lead se
 * mide el tiempo transcurrido, y a qué campo cae de fallback cuando el
 * real todavía no tiene valor (mismo criterio ya confirmado en
 * lead.model.timeTrigger.test.js del PR 1 — un lead sin lastContactedAt/
 * stageChangedAt seteado usa createdAt como si fuera "la última vez que
 * pasó algo").
 */
const TIME_TRIGGER_FIELDS = {
  lead_stale: {
    realField: 'lastContactedAt',
    fallbackField: 'createdAt',
  },
  stage_stalled: {
    realField: 'stageChangedAt',
    fallbackField: 'createdAt',
  },
};

const TIME_TRIGGER_TYPES = Object.keys(TIME_TRIGGER_FIELDS);

function esTriggerDeTiempo(triggerType) {
  return Object.prototype.hasOwnProperty.call(TIME_TRIGGER_FIELDS, triggerType);
}

/**
 * Busca la condición { field: 'daysThreshold', operator: 'greater_than',
 * value: N } dentro de trigger.conditions y devuelve N ya validado.
 * Lanza un error claro (nunca undefined/NaN silencioso) ante cualquier
 * configuración inválida: condición ausente, operador distinto de
 * 'greater_than', valor no numérico, o valor negativo (un umbral negativo
 * no tiene sentido — "hace más de -2 días" — a diferencia de 0, que sí es
 * válido: "hace más de 0 días" == "en cualquier momento antes de ahora").
 */
function extractDaysThreshold(conditions) {
  const lista = Array.isArray(conditions) ? conditions : [];
  const condicion = lista.find((c) => c?.field === DAYS_THRESHOLD_FIELD);

  if (!condicion) {
    throw new Error(
      `timeTriggers.registry: falta la condición "${DAYS_THRESHOLD_FIELD}" en trigger.conditions.`
    );
  }

  if (condicion.operator !== DAYS_THRESHOLD_OPERATOR) {
    throw new Error(
      `timeTriggers.registry: la condición "${DAYS_THRESHOLD_FIELD}" solo soporta el operador ` +
      `"${DAYS_THRESHOLD_OPERATOR}" (recibido: "${condicion.operator}").`
    );
  }

  const valor = Number(condicion.value);
  if (!Number.isFinite(valor)) {
    throw new Error(
      `timeTriggers.registry: el valor de "${DAYS_THRESHOLD_FIELD}" debe ser un número finito ` +
      `(recibido: ${JSON.stringify(condicion.value)}).`
    );
  }
  if (valor < 0) {
    throw new Error(
      `timeTriggers.registry: el valor de "${DAYS_THRESHOLD_FIELD}" no puede ser negativo (recibido: ${valor}).`
    );
  }

  return valor;
}

/**
 * Filtro de Mongo para encontrar leads candidatos de un trigger de tiempo
 * — se combina con {business, isDeleted:false} en el llamador (el sweep
 * del PR 3), nunca standalone. Usa el mismo $or con fallback a createdAt
 * ya validado en lead.model.timeTrigger.test.js (PR 1) — sin $expr, para
 * que Mongo pueda usar los índices {business,isDeleted,lastContactedAt}/
 * {business,isDeleted,stageChangedAt} que agregó ese PR.
 *
 * @param {string} triggerType - 'lead_stale' | 'stage_stalled'
 * @param {Array<{field:string, operator:string, value:*}>} conditions - trigger.conditions de la Automation
 * @param {Date} [now] - inyectable para tests; default new Date()
 * @returns {object} filtro de Mongo (sin business/isDeleted — los agrega el llamador)
 */
function assertTriggerDeTiempo(triggerType) {
  if (!esTriggerDeTiempo(triggerType)) {
    throw new Error(
      `timeTriggers.registry: tipo de trigger desconocido "${triggerType}" — los soportados son: ` +
      `${TIME_TRIGGER_TYPES.join(', ')}.`
    );
  }
}

function buildLeadCandidateFilter(triggerType, conditions, now = new Date()) {
  assertTriggerDeTiempo(triggerType);

  const dias = extractDaysThreshold(conditions);
  const cutoff = new Date(now.getTime() - dias * DAY_MS);
  const { realField, fallbackField } = TIME_TRIGGER_FIELDS[triggerType];

  return {
    $or: [
      { [realField]: { $lt: cutoff } },
      { [realField]: null, [fallbackField]: { $lt: cutoff } },
    ],
  };
}

/**
 * Conveniencia: mismo resultado que buildLeadCandidateFilter(), tomando
 * directamente un documento de Automation (lo que va a tener en la mano el
 * sweep del PR 3, en vez de desarmarlo campo por campo cada vez).
 *
 * @param {{trigger: {type: string, conditions: Array}}} automation
 * @param {Date} [now]
 */
function buildLeadCandidateFilterForAutomation(automation, now = new Date()) {
  return buildLeadCandidateFilter(automation?.trigger?.type, automation?.trigger?.conditions, now);
}

/**
 * Recheck (PR 3/3, automationExecute.worker.js): cuántos días pasaron desde
 * el campo real del lead (o su fallback a createdAt) para este trigger de
 * tiempo — mismo criterio de fallback y mismo redondeo (Math.floor) que
 * mission.service.js#diasDesde(), por consistencia con la única otra
 * lógica de "días sin seguimiento" que ya existe en el backend.
 *
 * Devuelve `null` si el lead no tiene NI el campo real NI createdAt (no
 * debería pasar nunca en la práctica — createdAt siempre lo pone
 * Mongoose — pero es una lectura defensiva, no una excepción, porque no es
 * una configuración inválida: es el lead el que no tiene datos).
 *
 * No usa automation.engine.js#getField()/evaluateCondition() a propósito:
 * ese evaluador genérico espera que `cond.field` sea un path DENTRO del
 * lead a mirar (ej. 'pipelineStage') — acá `field: 'daysThreshold'` es el
 * NOMBRE DEL PARÁMETRO de configuración, no un path del lead, así que no
 * encaja con ese mecanismo sin decorar el lead con un campo virtual que
 * conditionsMet() no sabría producir. Esta función aplica la misma lógica
 * (mismo extractDaysThreshold(), mismo campo real/fallback) del lado de JS
 * en vez de Mongo — así el filtro del sweep y el recheck de ejecución usan
 * exactamente la misma fuente de verdad y no pueden desincronizarse.
 *
 * @param {object} lead - documento (o lean object) de Lead
 * @param {string} triggerType - 'lead_stale' | 'stage_stalled'
 * @param {Date} [now]
 * @returns {number|null}
 */
function computeDaysSince(lead, triggerType, now = new Date()) {
  assertTriggerDeTiempo(triggerType);

  const { realField, fallbackField } = TIME_TRIGGER_FIELDS[triggerType];
  const fecha = lead?.[realField] || lead?.[fallbackField];
  if (!fecha) return null;

  return Math.floor((now.getTime() - new Date(fecha).getTime()) / DAY_MS);
}

/**
 * Recheck completo: ¿la condición de tiempo de esta Automation sigue
 * siendo cierta para este lead, AHORA? Usado por automationExecute.worker.js
 * justo antes de ejecutar — el barrido pudo haber encontrado a este lead
 * como candidato varios minutos (o más, si la cola tiene backlog) antes de
 * que este job corriera de verdad; en el medio, alguien pudo haberlo
 * contactado (o haber cambiado de etapa), y ya no correspondería ejecutar
 * la automatización.
 *
 * Fail-closed: si el lead no tiene fecha base (computeDaysSince devuelve
 * null), se considera que la condición NO se cumple — nunca ejecuta sobre
 * un dato ausente.
 *
 * @param {{trigger: {type: string, conditions: Array}}} automation
 * @param {object} lead
 * @param {Date} [now]
 * @returns {boolean}
 */
function conditionStillTrue(automation, lead, now = new Date()) {
  const dias = computeDaysSince(lead, automation?.trigger?.type, now);
  if (dias === null) return false;

  const umbral = extractDaysThreshold(automation?.trigger?.conditions);
  return dias > umbral;
}

module.exports = {
  TIME_TRIGGER_TYPES,
  DAYS_THRESHOLD_FIELD,
  extractDaysThreshold,
  buildLeadCandidateFilter,
  buildLeadCandidateFilterForAutomation,
  computeDaysSince,
  conditionStillTrue,
};
