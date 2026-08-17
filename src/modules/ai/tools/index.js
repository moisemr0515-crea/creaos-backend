const logger = require('../../../utils/logger');

/**
 * Registro de tools reales que el modelo puede invocar durante
 * generateReply() (ver ai.service.js) — primera y única tool por ahora:
 * escalate_to_human. El catálogo completo (Módulo 24/44 de docs/modules)
 * queda para PRs posteriores; este archivo está pensado para crecer
 * agregando entradas a TOOL_SCHEMAS + TOOL_EXECUTORS, no para reestructurarse.
 *
 * Nota de alcance: NO reutiliza ai.controller.js#escalate() tal cual —
 * ese es un handler de Express (depende de req/res/next y de
 * req.businessId para el scoping de tenant), no una función invocable
 * fuera de una request HTTP. Este archivo replica la misma mutación real
 * (status/escalatedAt/aiEnabled + mensaje del sistema) sobre el documento
 * de Conversation que generateReply() ya tiene cargado en memoria — sin
 * tocar ai.controller.js, fuera del alcance de este PR. Si en el futuro se
 * agregan más tools de acción que dupliquen lógica de otros controllers,
 * ahí sí vale la pena extraer un servicio compartido.
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

const TOOL_EXECUTORS = {
  escalate_to_human: escalateToHuman,
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
