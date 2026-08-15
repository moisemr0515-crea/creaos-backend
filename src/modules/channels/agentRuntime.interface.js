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
 * @property {{name: string, productDescription?: string, targetCustomer?: string, pdfSummary?: string, pdfExtractedText?: string, aiInstructions?: string}} businessContext
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
