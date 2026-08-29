const IChannelProvider = require('../channelProvider.interface');
// Se requiere el módulo completo (no se destructura sendWhatsAppMessage acá)
// para que la llamada use siempre la referencia viva del export — permite
// mockearlo en tests sin tocar el módulo real (ver _tmp-test-fase-1b.js).
const gupshupClient = require('../../webhooks/gupshup.client');
const channelCredentialsService = require('../channelCredentials.service');
const { GUPSHUP_PHONE_NUMBER } = require('../../../config/env');

/**
 * PR-07a (Plan Maestro §3/§5): arma el objeto `{apiKey, source, appName}`
 * que gupshup.client.js necesita para mandar/descargar por ESTE canal —
 * PLATFORM o DEDICATED, sin distinción acá (resolveCredentials() ya
 * encapsula esa rama). `source`/`appName` NO son secretos — viven en el
 * propio WhatsAppChannel (`phoneNumber`/`providerAccountId`), no hace falta
 * resolveCredentials() para ellos.
 *
 * Errores de resolveCredentials() (canal DEDICATED sin ChannelCredentials,
 * apiKeys revocadas, dato cifrado ilegible — todos AppError fail-loud) se
 * propagan tal cual, sin capturar acá — el fail-soft ya existe una capa
 * arriba, en cada call site de channelService (ai.service.js/webhook.service.js/
 * outbound.worker.js), que ya envuelve sendMessage()/sendTemplate()/sendMedia()
 * en try/catch y marca el mensaje/evento como fallido sin relanzar.
 *
 * @param {import('../whatsappChannel.model')} channel
 * @returns {Promise<{ apiKey: string, source: string, appName: string }>}
 */
async function resolverCredencialesDeEnvio(channel) {
  const { apiKey } = await channelCredentialsService.resolveCredentials(channel);
  return { apiKey, source: channel.phoneNumber, appName: channel.providerAccountId };
}

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
    // PR-07a: `channel` ya no se ignora — resuelve las credenciales REALES
    // de este canal (PLATFORM: env vars de siempre; DEDICATED: apikey del
    // tenant, cifrada en ChannelCredentials desde PR-06) y arma el origen/
    // nombre de app a partir del propio documento, no de env vars globales.
    const credenciales = await resolverCredencialesDeEnvio(channel);
    return gupshupClient.sendWhatsAppMessage(to, text, credenciales);
  }

  /**
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} to
   * @param {{ id: string, params?: string[] }} template
   */
  async sendTemplate(channel, to, template) {
    // Mismo criterio que sendMessage() (PR-07a).
    const credenciales = await resolverCredencialesDeEnvio(channel);
    return gupshupClient.sendTemplateMessage(to, template, credenciales);
  }

  /**
   * GAP CONOCIDO, fuera de alcance de PR-07a a propósito (no es una función
   * de "envío" — es lectura/listado): sigue sin usar `channel`, mismo motivo
   * que gupshup.client.js#listTemplates() (GUPSHUP_APP_ID global) — un canal
   * DEDICATED vería siempre las plantillas de la app de CREA OS.
   *
   * @param {import('../whatsappChannel.model')} _channel — no usado hoy.
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
    // Mismo criterio que sendMessage()/sendTemplate() (PR-07a).
    const credenciales = await resolverCredencialesDeEnvio(channel);
    return gupshupClient.sendMediaMessage(to, media, credenciales);
  }

  /**
   * PR-07a: la media entrante de un canal DEDICATED vive detrás del apikey
   * DE ESA app, no el de PLATFORM — mismo criterio que el resto de este
   * archivo. Solo necesita `apiKey` (no `source`/`appName`, que gupshup.client.js#
   * downloadMedia() no usa), pero se reutiliza resolverCredencialesDeEnvio()
   * tal cual para no duplicar la llamada a resolveCredentials().
   *
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} mediaUrl
   */
  async downloadMedia(channel, mediaUrl) {
    const { apiKey } = await resolverCredencialesDeEnvio(channel);
    return gupshupClient.downloadMedia(mediaUrl, { apiKey });
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
