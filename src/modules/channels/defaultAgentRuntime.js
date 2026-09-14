const IAgentRuntime = require('./agentRuntime.interface');
const Lead = require('../leads/lead.model');
const aiService = require('../ai/ai.service');
const { assertTenantScope } = require('./tenant.resolver');
const { OPENAI_MODEL } = require('../../config/env');
const subscriptionService = require('../subscriptions/subscription.service');

/**
 * DefaultAgentRuntime — implementación de Fase 0-3 (sub-fase 1.d). Envoltorio
 * literal de ai.service.js#generateReply() actual, sin agregar inteligencia
 * nueva — el objetivo es fijar el contrato ahora para que Bloque C lo
 * sustituya después sin tocar Worker/Gateway (Blueprint §4.7).
 *
 * CREA SALES AI™ C.3, Etapa C3.1b: desde acá se llama a
 * aiService.runAgent() (Etapa C3.1) en vez de generateReply() directo —
 * unifica este camino (todavía apagado por WHATSAPP_QUEUE_PROCESSING_ENABLED)
 * con el mismo Runtime Contract que ya usa el camino activo en producción
 * (webhook.service.js#processGupshupMessage()). El AgentRuntimeOutput que
 * este método devuelve NO cambia de forma — sigue siendo
 * {reply, actions, aiEnabled, metadata} tal cual esperaba
 * inbound.worker.js#processInboundJob() desde antes de C.3 — runAgent()
 * solo agrega el vocabulario nuevo (outcome/toolsUsed/knowledgeSources/
 * correlationId) que esta clase no necesita exponer todavía (queda para
 * cuando el Worker mismo se actualice a consumirlo, fuera de alcance de
 * este PR).
 *
 * Usa generateReply() (vía runAgent()), NO chat() — asume que el mensaje
 * entrante del lead YA está guardado en conversation.messages antes de
 * llegar acá (lo hace inbound.worker.js#processInboundJob(), SIEMPRE, sin
 * importar si esta clase termina generando una respuesta o no — mismo
 * criterio que webhook.service.js#processGupshupMessage(), ver
 * ai.service.js#saveInboundMessage() para el porqué). Si esto llamara a
 * chat() en vez de generateReply()/runAgent(), el mensaje del lead
 * quedaría duplicado en conversation.messages.
 *
 * AgentRuntimeInput solo trae `leadId` (no el Lead completo) — se re-consulta
 * acá porque ai.service.js#generateReply()/buildSystemPrompt() necesita
 * varios campos del Lead (name, company, temperature, pipelineStage,
 * potentialValue, currency) que el contrato no carga, y mantener el input
 * liviano es deliberado: es el shape que viaja como payload de un job de
 * BullMQ.
 */
class DefaultAgentRuntime extends IAgentRuntime {
  async process(input) {
    const lead = await Lead.findById(input.leadId);
    if (!lead) {
      // Lead borrado entre que se encoló el job y se procesó — caso borde,
      // no se responde (no hay a quién).
      return { reply: null, actions: [], aiEnabled: false, metadata: { tokensUsed: 0, model: OPENAI_MODEL } };
    }

    // C.3, Etapa C3.6 (Pilot Hardening): assertTenantScope() ya existía en
    // tenant.resolver.js (usado en el pipeline de canal, sub-fases 1.c/1.d)
    // pero nunca se llamaba desde acá — hallazgo de la auditoría de C.3, §5
    // (riesgo de aislamiento). Hoy el único caller real (inbound.worker.js)
    // siempre arma leadId/businessContext desde el mismo businessId, así que
    // esto no es explotable en producción todavía (además el camino está
    // apagado por WHATSAPP_QUEUE_PROCESSING_ENABLED=false) — pero es
    // exactamente el tipo de "rompe en silencio entre pasos" que
    // assertTenantScope() existe para atajar antes de activar el flag.
    assertTenantScope(input.businessContext?._id, lead.business);

    const entitlement = await subscriptionService.getEntitlement(input.businessContext?._id);
    if (!entitlement.limits.aiEnabled
      || !entitlement.limits.whatsappEnabled
      || !entitlement.limits.automationsEnabled) {
      return {
        reply: null,
        actions: [],
        aiEnabled: false,
        metadata: { tokensUsed: 0, model: OPENAI_MODEL, entitlementBlocked: true },
      };
    }

    // input.businessContext debe ser el documento Business COMPLETO desde
    // la Etapa C3.1b — ver agentRuntime.interface.js para el porqué
    // (gap real encontrado en la auditoría de C.3, §3.3).
    const result = await aiService.runAgent({
      conversationId: input.conversationId,
      business: input.businessContext,
      lead,
    });

    // C.3, Etapa C3.3 (Action Outcomes). Desde esta etapa, runAgent() ya
    // no deja propagar una excepción cruda de generateReply() — la
    // normaliza a outcome:'error' (ver ai.service.js#runAgent()). Se
    // relanza acá para preservar el mismo efecto downstream que daba la
    // excepción cruda de antes de C3.3: BullMQ (startInboundWorker(),
    // inbound.worker.js) reintenta el job según DEFAULT_JOB_OPTIONS y lo
    // manda a dead-letter si agota los intentos — sin este `throw`, un
    // fallo real quedaría indistinguible de "el agente decidió no
    // responder" (reply:null), sin reintento ni visibilidad.
    if (result.outcome === 'error') {
      throw new Error(`El agente no pudo generar una respuesta: ${result.errorCode}`);
    }

    return {
      reply: result.responseText,
      actions: [], // M01-44 no implementado — Bloque C, fuera de alcance
      aiEnabled: true,
      metadata: { tokensUsed: result.tokensUsed, model: OPENAI_MODEL },
    };
  }
}

module.exports = DefaultAgentRuntime;
