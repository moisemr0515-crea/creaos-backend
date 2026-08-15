const IChannelProvider = require('../channelProvider.interface');
// Se requiere el módulo completo (no se destructura sendWhatsAppMessage acá)
// para que la llamada use siempre la referencia viva del export — permite
// mockearlo en tests sin tocar el módulo real (ver _tmp-test-fase-1b.js).
const gupshupClient = require('../../webhooks/gupshup.client');

/**
 * GupshupProvider — primera (y única, Fase 0-3) implementación de
 * IChannelProvider. Envuelve gupshup.client.js casi sin cambios internos
 * (Blueprint §4.2) — implementa solo lo que Fase 0-3 necesita hoy:
 * sendMessage() y normalizeInboundEvent(). El resto de métodos del
 * contrato hereda el stub `not_implemented_v1` de la clase base.
 */
class GupshupProvider extends IChannelProvider {
  /**
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} to
   * @param {string} text
   */
  async sendMessage(channel, to, text) {
    // gupshup.client.js#sendWhatsAppMessage() todavía usa el número
    // compartido (GUPSHUP_PHONE_NUMBER) internamente, no el `channel` que
    // recibe acá — se acepta el parámetro para cumplir el contrato y
    // porque cuando exista un número dedicado por tenant (Fase 2), el
    // cambio queda acotado a gupshup.client.js, no a este wrapper.
    return gupshupClient.sendWhatsAppMessage(to, text);
  }

  /**
   * Traduce el payload crudo de Gupshup (formato "legacy" o "v3"/passthrough
   * Meta) al evento canónico. Misma lógica que hoy vive en
   * webhook.service.js#parseGupshupPayload() + #extractGupshupAppIdentifiers()
   * (líneas 287-336) — movida acá tal cual, sin cambios de comportamiento.
   *
   * @returns {Array<{providerMessageId: string, from: string, text: string, name: string, channelIdentifiers: object}>}
   */
  normalizeInboundEvent(rawPayload) {
    const channelIdentifiers = this._extractIdentifiers(rawPayload);

    if (rawPayload?.object === 'whatsapp_business_account' && Array.isArray(rawPayload.entry)) {
      const results = [];
      for (const entry of rawPayload.entry) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const { messages = [], contacts = [] } = change.value || {};
          for (const msg of messages) {
            if (msg.type !== 'text') continue;
            const from = msg.from;
            const contact = contacts.find((c) => c.wa_id === from);
            results.push({
              providerMessageId: msg.id,
              from,
              text: msg.text?.body || '',
              name: contact?.profile?.name || from,
              channelIdentifiers,
            });
          }
        }
      }
      return results;
    }

    if (rawPayload?.type === 'message') {
      const from = rawPayload.payload?.sender?.phone;
      const text = rawPayload.payload?.payload?.text;
      if (!from || !text) return [];
      return [{
        providerMessageId: rawPayload.payload?.id,
        from,
        text,
        name: rawPayload.payload?.sender?.name || from,
        channelIdentifiers,
      }];
    }

    return [];
  }

  /** Idéntico a extractGupshupAppIdentifiers() de webhook.service.js. */
  _extractIdentifiers(rawPayload) {
    if (rawPayload?.object === 'whatsapp_business_account' && Array.isArray(rawPayload.entry)) {
      const entry = rawPayload.entry[0];
      return {
        format: 'v3',
        gsAppId: rawPayload.gs_app_id,
        wabaId: entry?.id,
        phoneNumberId: entry?.changes?.[0]?.value?.metadata?.phone_number_id,
      };
    }
    return { format: 'legacy', appName: rawPayload?.app };
  }
}

module.exports = GupshupProvider;
