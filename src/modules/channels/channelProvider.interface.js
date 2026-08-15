/**
 * IChannelProvider — contrato que debe implementar cualquier proveedor de
 * mensajería (Plan Maestro §26; Implementation Blueprint §4.2).
 *
 * Repo en JS puro (sin TypeScript) — el contrato se fuerza por herencia:
 * cada método de esta clase lanza `not_implemented_v1` por defecto. Una
 * subclase (ej. GupshupProvider) solo necesita overridear los métodos que
 * de verdad implementa; el resto sigue fallando explícitamente si algo los
 * llama antes de tiempo, en vez de fallar en silencio o devolver `undefined`.
 *
 * v1 (sub-fase 1.b): se fija el contrato completo. Solo GupshupProvider lo
 * implementa, y solo parcialmente (ver gupshup.provider.js) — sendTemplate/
 * sendMedia/onboardChannel reales llegan en Fase 2 (Embedded Signup).
 */
class IChannelProvider {
  /** Envía un mensaje de texto por el canal. */
  async sendMessage(_channel, _to, _text) {
    throw new Error('not_implemented_v1: sendMessage');
  }

  /** Envía un mensaje de plantilla aprobada (WhatsApp Business templates). */
  async sendTemplate(_channel, _to, _templateName, _params) {
    throw new Error('not_implemented_v1: sendTemplate');
  }

  /** Envía un mensaje con medios adjuntos (imagen/documento/audio). */
  async sendMedia(_channel, _to, _mediaUrl, _caption) {
    throw new Error('not_implemented_v1: sendMedia');
  }

  /** Consulta el estado operativo del canal contra el proveedor. */
  async getChannelStatus(_channel) {
    throw new Error('not_implemented_v1: getChannelStatus');
  }

  /** Registra/actualiza la suscripción de webhook del canal ante el proveedor. */
  async registerWebhook(_channel) {
    throw new Error('not_implemented_v1: registerWebhook');
  }

  /** Flujo de onboarding de un canal nuevo (Embedded Signup u equivalente). */
  async onboardChannel(_tenantId, _onboardingData) {
    throw new Error('not_implemented_v1: onboardChannel');
  }

  /** Desconecta/da de baja un canal existente. */
  async disconnectChannel(_channel) {
    throw new Error('not_implemented_v1: disconnectChannel');
  }

  /**
   * Traduce el payload crudo del proveedor a un evento canónico:
   * {providerMessageId, from, text, channelIdentifiers}.
   * NO resuelve el WhatsAppChannel/tenantId — eso lo hace ChannelResolver
   * a partir de `channelIdentifiers` (ver Blueprint §4.2, nota de diseño).
   */
  normalizeInboundEvent(_rawPayload) {
    throw new Error('not_implemented_v1: normalizeInboundEvent');
  }
}

module.exports = IChannelProvider;
