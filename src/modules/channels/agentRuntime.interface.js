/**
 * IAgentRuntime — contrato mínimo entre la plataforma (Message Gateway /
 * Worker) y el "cerebro" que decide qué responder (Blueprint §4.7).
 *
 * El Worker SIEMPRE llama a AgentRuntime.process(input) → output, nunca a
 * openai.chat.completions.create() ni a ai.service.js#chat() directamente
 * — ese nivel de indirección es lo que permite que Bloque C (M01-44, CREA
 * Sales AI real) reemplace DefaultAgentRuntime sin tocar el Worker, el
 * Gateway ni el Channel layer.
 *
 * @typedef {object} AgentRuntimeInput
 * @property {string} tenantId
 * @property {string} channelId
 * @property {string} conversationId
 * @property {string} leadId
 * @property {{text: string, providerMessageId: string, timestamp: Date}} message
 * @property {object} businessContext — el documento Business COMPLETO
 *   (Mongoose), no un subconjunto elegido a mano. Hasta la Etapa C3.1b de
 *   C.3 (docs/implementation/c3-runtime-current-state.md §3.3) este campo
 *   traía solo 6 campos (name/productDescription/targetCustomer/
 *   pdfSummary/pdfExtractedText/aiInstructions) — le faltaban `_id` (que
 *   TODAS las tools de Product Intelligence/Business Knowledge necesitan
 *   para escopar por tenant) y `aiPersonality` (que buildSystemPrompt()
 *   usa) — un gap real que hubiera roto esas tools en silencio si este
 *   camino se hubiera activado tal cual. Se corrigió pasando el documento
 *   completo en vez de seguir manteniendo una lista de campos a mano.
 * @property {Array<{role: string, content: string}>} conversationHistory
 *
 * @typedef {object} AgentRuntimeOutput
 * @property {string|null} reply — null si la decisión es "no responder todavía"
 * @property {Array<{type: string, config: object}>} actions — vacío siempre en Fase 0-3 (M01-44 no implementado)
 * @property {boolean} aiEnabled
 * @property {{tokensUsed: number, model: string, promptTokens?: number, completionTokens?: number}} metadata
 */
class IAgentRuntime {
  /**
   * @param {AgentRuntimeInput} _input
   * @returns {Promise<AgentRuntimeOutput>}
   */
  async process(_input) {
    throw new Error('not_implemented_v1: process');
  }
}

module.exports = IAgentRuntime;
