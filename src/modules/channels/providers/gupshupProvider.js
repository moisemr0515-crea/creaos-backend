const IChannelProvider = require('../channelProvider.interface');
// Se requiere el módulo completo (no se destructura sendWhatsAppMessage acá)
// para que la llamada use siempre la referencia viva del export — permite
// mockearlo en tests sin tocar el módulo real (ver _tmp-test-fase-1b.js).
const gupshupClient = require('../../webhooks/gupshup.client');
const { GUPSHUP_PHONE_NUMBER } = require('../../../config/env');

// Tipos de media ENTRANTE soportados por normalizeInboundEvent() — mismo
// alcance que el envío saliente (ai.service.js#sendMediaMessage) y que
// webhook.service.js#parseGupshupPayload().
const MEDIA_TYPES_SOPORTADOS = ['image', 'video'];

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
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} to
   * @param {{ id: string, params?: string[] }} template
   */
  async sendTemplate(channel, to, template) {
    // Mismo criterio que sendMessage(): el `channel` se acepta por contrato,
    // gupshup.client.js todavía resuelve el origen (GUPSHUP_PHONE_NUMBER) y
    // la app (GUPSHUP_APP_ID) de forma global, no por canal.
    return gupshupClient.sendTemplateMessage(to, template);
  }

  /**
   * @param {import('../whatsappChannel.model')} _channel — no usado hoy,
   *   mismo motivo que sendTemplate()/getChannelStatus().
   * @returns {Promise<Array>}
   */
  async listTemplates(_channel) {
    return gupshupClient.listTemplates();
  }

  /**
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} to
   * @param {{ url: string, type: 'image'|'video', caption?: string }} media
   */
  async sendMedia(channel, to, media) {
    // Mismo criterio que sendMessage()/sendTemplate(): el `channel` se
    // acepta por contrato, gupshup.client.js todavía resuelve el origen de
    // forma global, no por canal.
    return gupshupClient.sendMediaMessage(to, media);
  }

  /**
   * @param {import('../whatsappChannel.model')} _channel — no usado hoy, mismo motivo que el resto.
   * @param {string} mediaUrl
   */
  async downloadMedia(_channel, mediaUrl) {
    return gupshupClient.downloadMedia(mediaUrl);
  }

  /**
   * Estado operativo del canal — Fase 1.1 (Provider Abstraction). Envuelve
   * gupshup.client.js#estaConfigurado() (config-presence check, sin
   * llamada en vivo a la API de Gupshup, mismo criterio que ya usaba
   * whatsapp.controller.js#getStatus() antes de este refactor).
   *
   * @param {import('../whatsappChannel.model')} _channel — no usado hoy:
   *   estaConfigurado() sigue siendo global (env vars), no por canal — el
   *   parámetro se acepta para cumplir el contrato, igual que sendMessage().
   * @returns {Promise<{connected: boolean, provider: string, phoneNumber: string|null}>}
   */
  async getChannelStatus(_channel) {
    const connected = gupshupClient.estaConfigurado();
    return { connected, provider: 'gupshup', phoneNumber: connected ? GUPSHUP_PHONE_NUMBER : null };
  }

  /**
   * Traduce el payload crudo de Gupshup (formato "legacy" o "v3"/passthrough
   * Meta) al evento canónico. Misma lógica que
   * webhook.service.js#parseGupshupPayload() + #extractGupshupAppIdentifiers()
   * — reconoce 'text', 'image' y 'video' (mismo alcance que el envío
   * saliente de media), igual que se corrigió en parseGupshupPayload()
   * (ai,webhooks): feat/inbound-media-messages. `mediaSourceUrl` es la URL
   * TEMPORAL que trae el payload — nunca se usa tal cual, se descarga y
   * re-aloja en Cloudinary al procesar el evento.
   *
   * @returns {Array<{providerMessageId: string, from: string, text: string, name: string, mediaType?: 'image'|'video', mediaSourceUrl?: string, channelIdentifiers: object}>}
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
            const from = msg.from;
            const contact = contacts.find((c) => c.wa_id === from);
            const base = { providerMessageId: msg.id, from, name: contact?.profile?.name || from, channelIdentifiers };

            if (msg.type === 'text') {
              results.push({ ...base, text: msg.text?.body || '' });
            } else if (MEDIA_TYPES_SOPORTADOS.includes(msg.type)) {
              const mediaField = msg[msg.type];
              if (!mediaField?.url) continue;
              results.push({
                ...base,
                text: mediaField.caption || '',
                mediaType: msg.type,
                mediaSourceUrl: mediaField.url,
              });
            }
            // otros tipos: se ignoran, mismo comportamiento que antes
          }
        }
      }
      return results;
    }

    if (rawPayload?.type === 'message') {
      const from = rawPayload.payload?.sender?.phone;
      const name = rawPayload.payload?.sender?.name || from;
      const providerMessageId = rawPayload.payload?.id;
      const payloadType = rawPayload.payload?.type;

      if (payloadType === 'text') {
        const text = rawPayload.payload?.payload?.text;
        if (!from || !text) return [];
        return [{ providerMessageId, from, text, name, channelIdentifiers }];
      }

      if (MEDIA_TYPES_SOPORTADOS.includes(payloadType)) {
        const mediaUrl = rawPayload.payload?.payload?.url;
        if (!from || !mediaUrl) return [];
        return [{
          providerMessageId,
          from,
          name,
          channelIdentifiers,
          text: rawPayload.payload?.payload?.caption || '',
          mediaType: payloadType,
          mediaSourceUrl: mediaUrl,
        }];
      }

      return [];
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
