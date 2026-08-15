const IAgentRuntime = require('./agentRuntime.interface');
const Lead = require('../leads/lead.model');
const aiService = require('../ai/ai.service');
const { OPENAI_MODEL } = require('../../config/env');

/**
 * DefaultAgentRuntime — implementación de Fase 0-3 (sub-fase 1.d). Envoltorio
 * literal de ai.service.js#chat() actual, sin agregar inteligencia nueva —
 * el objetivo es fijar el contrato ahora para que Bloque C lo sustituya
 * después sin tocar Worker/Gateway (Blueprint §4.7).
 *
 * AgentRuntimeInput solo trae `leadId` (no el Lead completo) — se re-consulta
 * acá porque ai.service.js#chat()/buildSystemPrompt() necesita varios campos
 * del Lead (name, company, temperature, pipelineStage, potentialValue,
 * currency) que el contrato no carga, y mantener el input liviano es
 * deliberado: es el shape que viaja como payload de un job de BullMQ.
 */
class DefaultAgentRuntime extends IAgentRuntime {
  async process(input) {
    const lead = await Lead.findById(input.leadId);
    if (!lead) {
      // Lead borrado entre que se encoló el job y se procesó — caso borde,
      // no se responde (no hay a quién).
      return { reply: null, actions: [], aiEnabled: false, metadata: { tokensUsed: 0, model: OPENAI_MODEL } };
    }

    const { reply, tokensUsed } = await aiService.chat(input.conversationId, input.message.text, input.businessContext, lead);

    return {
      reply,
      actions: [], // M01-44 no implementado — Bloque C, fuera de alcance
      aiEnabled: true,
      metadata: { tokensUsed, model: OPENAI_MODEL },
    };
  }
}

module.exports = DefaultAgentRuntime;
