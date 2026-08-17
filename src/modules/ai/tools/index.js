const logger = require('../../../utils/logger');
const Lead = require('../../leads/lead.model');
// Módulo completo (no se destructura cambiarEtapa acá) — misma convención
// de "referencia viva" que el resto del repo (ver cloudinaryUtil en
// ai.service.js, gupshup.client.js, etc.).
const leadService = require('../../leads/lead.service');

/**
 * Registro de tools reales que el modelo puede invocar durante
 * generateReply() (ver ai.service.js): escalate_to_human (PR33) y
 * update_lead_stage (PR38). El catálogo completo (Módulo 24/44 de
 * docs/modules) queda para PRs posteriores; este archivo está pensado
 * para crecer agregando entradas a TOOL_SCHEMAS + TOOL_EXECUTORS, no para
 * reestructurarse.
 *
 * Nota de alcance sobre escalate_to_human: NO reutiliza
 * ai.controller.js#escalate() tal cual — ese es un handler de Express
 * (depende de req/res/next y de req.businessId para el scoping de
 * tenant), no una función invocable fuera de una request HTTP. Este
 * archivo replica la misma mutación real (status/escalatedAt/aiEnabled +
 * mensaje del sistema) sobre el documento de Conversation que
 * generateReply() ya tiene cargado en memoria — sin tocar
 * ai.controller.js, fuera del alcance de ese PR.
 *
 * update_lead_stage (PR38) es distinto: lead.service.js#cambiarEtapa() ya
 * es un service standalone (no atado a un controller de Express), así que
 * acá SÍ se reutiliza tal cual, sin duplicar nada — ver executor abajo.
 */

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Escala esta conversación a un agente humano y desactiva las respuestas automáticas de la IA. ' +
        'Úsala cuando el lead pide explícitamente hablar con una persona, muestra frustración fuerte con ' +
        'la IA, o la situación excede lo que puedes resolver como agente de ventas conversacional ' +
        '(reclamos, disputas de pago, algo fuera de tu alcance). No la uses solo porque el lead hizo ' +
        'una pregunta difícil que sí puedes intentar responder.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Motivo breve y concreto del escalamiento, en español, para que el agente humano tenga contexto inmediato.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_lead_stage',
      description:
        'Actualiza la etapa del lead en el pipeline de ventas del negocio. Úsala cuando la conversación deja ' +
        'claro que el lead avanzó a una etapa distinta del proceso comercial (ej. pasó de "interesado" a pedir ' +
        'una propuesta formal, a negociar condiciones, o decidió no continuar). Etapas típicas: new, contacted, ' +
        'interested, proposal, negotiation, won, lost — pero cada negocio puede tener las suyas propias; si usas ' +
        'una etapa que no existe para este negocio, el sistema te devuelve la lista de etapas válidas para que ' +
        'reintentes con la correcta. No la uses solo porque el lead hizo una pregunta — solo ante una señal real ' +
        'de cambio de etapa.',
      parameters: {
        type: 'object',
        properties: {
          stage: {
            type: 'string',
            description: 'Clave (key) de la etapa destino. Usa la que corresponda al pipeline real de este negocio si la conoces por el contexto; si no, usa una etapa típica (new, contacted, interested, proposal, negotiation, won, lost).',
          },
          reason: {
            type: 'string',
            description: 'Motivo breve del cambio de etapa, para el registro de actividad del lead. Opcional — no lo inventes si el lead simplemente avanzó de forma natural en la conversación.',
          },
        },
        required: ['stage'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Ejecuta el escalamiento real sobre el documento de Conversation que ya
 * tiene cargado generateReply() — muta el objeto en memoria (status,
 * escalatedAt, aiEnabled, + mensaje de sistema) pero NO llama a
 * conversation.save(): ese guardado es responsabilidad exclusiva de
 * generateReply(), en un único save al final del loop, para evitar dos
 * escrituras independientes sobre el mismo documento (la del tool y la del
 * loop) pisándose entre sí.
 *
 * Idempotente a propósito: si la conversación ya estaba escalada (por este
 * mismo flujo, o porque un humano ya la escaló manualmente vía
 * ai.controller.js#escalate mientras tanto), no vuelve a mutar nada — le
 * avisa al modelo que ya estaba escalada para que pueda responder acorde,
 * en vez de lanzar un error que cortaría el loop de generateReply().
 */
const escalateToHuman = async (args, { conversation }) => {
  const reason = typeof args?.reason === 'string' && args.reason.trim()
    ? args.reason.trim()
    : 'La IA determinó que la conversación requiere intervención humana.';

  if (conversation.status === 'escalated') {
    return { success: true, alreadyEscalated: true, message: 'La conversación ya estaba escalada a un agente humano.' };
  }

  conversation.status = 'escalated';
  conversation.escalatedAt = new Date();
  conversation.aiEnabled = false;
  conversation.messages.push({
    role: 'system',
    content: `Conversación escalada a humano por la IA. Motivo: ${reason}`,
    timestamp: new Date(),
  });

  return { success: true, alreadyEscalated: false, message: 'Conversación escalada a un agente humano exitosamente.' };
};

/**
 * Actualiza conversation.lead a la etapa que pide el modelo, reutilizando
 * tal cual lead.service.js#cambiarEtapa() — sin duplicar su validación
 * (pipeline real del negocio, no un enum fijo) ni sus efectos secundarios
 * (activity log, triggerAutomations('lead_stage_changed', ...)).
 *
 * Idempotente por lectura fresca, a propósito: NO usa el `lead` que
 * generateReply() ya tiene en memoria (context.lead) — ese fue cargado al
 * INICIO del turno y puede haber quedado desactualizado si esta misma
 * tool ya corrió antes en el mismo loop (cambiarEtapa() muta y guarda su
 * propio documento recién consultado, no el objeto `lead` que se pasa acá
 * por contexto). Por eso se relee pipelineStage directo de Mongo antes de
 * decidir si hay algo que hacer.
 *
 * No lanza su propio try/catch: cualquier error de cambiarEtapa() (etapa
 * inválida para el pipeline de este negocio, lead no encontrado) lo
 * captura executeToolCall() de abajo, que ya envuelve toda ejecución de
 * executor — mismo criterio fail-soft que escalateToHuman(), sin
 * duplicar el manejo de errores acá.
 */
const updateLeadStage = async (args, { conversation }) => {
  const stage = typeof args?.stage === 'string' ? args.stage.trim() : '';
  if (!stage) {
    return { success: false, error: 'Falta el parámetro "stage" (obligatorio).' };
  }

  const leadActual = await Lead.findOne(
    { _id: conversation.lead, business: conversation.business, isDeleted: false },
    '_id pipelineStage'
  );
  if (!leadActual) {
    return { success: false, error: 'El lead asociado a esta conversación no existe o fue eliminado.' };
  }

  if (leadActual.pipelineStage === stage) {
    return { success: true, alreadyInStage: true, message: `El lead ya estaba en la etapa "${stage}".` };
  }

  const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
  // Actor sintético — no hay un User humano detrás de esta mutación.
  // performedBy queda sin setear (no es required en activitySchema);
  // performedByName sí se guarda, para que el activity log del lead
  // distinga a simple vista una acción de la IA de una de un humano.
  const actorIA = { _id: undefined, name: 'CREA (IA)' };

  const leadActualizado = await leadService.cambiarEtapa(conversation.business, conversation.lead, actorIA, stage, reason);

  return {
    success: true,
    alreadyInStage: false,
    message: `Etapa del lead actualizada a "${stage}".`,
    pipelineStage: leadActualizado.pipelineStage,
  };
};

const TOOL_EXECUTORS = {
  escalate_to_human: escalateToHuman,
  update_lead_stage: updateLeadStage,
};

/**
 * Punto de entrada único que usa generateReply() para correr una tool call
 * que pidió el modelo. Nunca lanza — cualquier error (JSON de argumentos
 * inválido, tool desconocida, excepción del executor) se devuelve como
 * resultado con success:false en vez de propagarse, para que el loop de
 * generateReply() pueda seguir y el modelo tenga la chance de responderle
 * al lead igual (fail-soft, mismo criterio que saveInboundMessage() con la
 * media entrante).
 *
 * @param {object} toolCall - tal cual lo devuelve OpenAI (choices[0].message.tool_calls[i])
 * @param {{ conversation: import('../conversation.model'), business: object, lead: object }} context
 * @returns {Promise<object>} resultado serializable, nunca undefined
 */
const executeToolCall = async (toolCall, context) => {
  const name = toolCall?.function?.name;
  const executor = TOOL_EXECUTORS[name];

  if (!executor) {
    logger.error(`generateReply(): el modelo pidió una tool desconocida: ${name}`);
    return { success: false, error: `Tool desconocida: ${name}` };
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch (error) {
    logger.error(`generateReply(): argumentos de tool call inválidos para ${name}: ${error.message}`);
    return { success: false, error: 'Argumentos de la tool inválidos (JSON malformado).' };
  }

  try {
    return await executor(args, context);
  } catch (error) {
    logger.error(`generateReply(): error ejecutando tool ${name}: ${error.message}`);
    return { success: false, error: `Error ejecutando ${name}: ${error.message}` };
  }
};

module.exports = { TOOL_SCHEMAS, TOOL_EXECUTORS, executeToolCall };
