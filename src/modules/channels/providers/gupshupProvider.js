const IChannelProvider = require('../channelProvider.interface');
// Se requiere el módulo completo (no se destructura sendWhatsAppMessage acá)
// para que la llamada use siempre la referencia viva del export — permite
// mockearlo en tests sin tocar el módulo real (ver _tmp-test-fase-1b.js).
const gupshupClient = require('../../webhooks/gupshup.client');
// PR1 (docs/implementation/known-issues.md, 07/sep/2026): cliente HERMANO,
// no reemplazo — gupshup.client.js (Legacy/self-serve) queda sin tocar,
// sigue siendo el único camino de PLATFORM.
const gupshupPartnerClient = require('../../webhooks/gupshup.partner.client');
const channelCredentialsService = require('../channelCredentials.service');
const { GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH } = require('../../../config/env');
const { AppError } = require('../../../middleware/error.middleware');
const logger = require('../../../utils/logger');

/**
 * PR2 (docs/implementation/known-issues.md, 07/sep/2026): ÚNICO punto de
 * decisión Legacy/Partner de todo el backend — reemplaza el allowlist
 * global de PR1 (GUPSHUP_PARTNER_OUTBOUND_APP_IDS) por la fuente de verdad
 * POR CANAL: `WhatsAppChannel.outboundApi`. El allowlist de PR1 queda
 * declarada en env.js pero YA NO SE LEE ACÁ — solo como mecanismo temporal
 * de transición, ver ese archivo.
 *
 * Orden de chequeos, cada uno explícito (nunca un fallback implícito):
 *   1. Kill switch de emergencia (GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH) —
 *      fuerza Legacy para TODO, sin importar outboundApi. Mecanismo de
 *      incidente amplio de Partner API, NO el routing normal.
 *   2. PLATFORM → Legacy siempre. Defensa en profundidad: PLATFORM ya
 *      debería tener outboundApi:'legacy' por diseño (nunca pasó por
 *      Partner API, no tiene Partner App Access Token posible), pero se
 *      chequea aparte por si algún día se edita mal a mano.
 *   3. outboundApi === 'partner' → requiere `providerAppId` (va en la URL
 *      de Partner API). Si falta, es una CONFIGURACIÓN INCONSISTENTE —
 *      NUNCA cae silenciosamente a Legacy (podría enviar por el número/app
 *      equivocado sin que nadie lo note, el mismo tipo de bug que ya
 *      costó una investigación completa esta semana) — tira un AppError
 *      controlado e identificable en cambio.
 *   4. outboundApi === 'legacy', o el campo ausente (documento viejo, sin
 *      backfill de PR2 todavía — `.lean()` no aplica defaults del schema)
 *      → Legacy. Mismo resultado para ambos casos, ninguno es un error:
 *      es el estado "todavía no migrado a Partner".
 *
 * @param {import('../whatsappChannel.model')} channel
 * @returns {'legacy'|'partner'}
 * @throws {AppError} si outboundApi:'partner' pero providerAppId falta —
 *   configuración inconsistente, requiere revisión manual (nunca un fallback).
 */
function resolveOutboundMode(channel) {
  if (GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH) return 'legacy';
  if (channel.connectionType === 'PLATFORM') return 'legacy';

  if (channel.outboundApi === 'partner') {
    if (!channel.providerAppId) {
      throw new AppError(
        `Canal ${channel._id} declarado outboundApi:'partner' pero sin providerAppId — configuración inconsistente, requiere revisión manual`,
        500
      );
    }
    return 'partner';
  }

  return 'legacy';
}

/**
 * PR-07a (Plan Maestro §3/§5): arma el objeto `{apiKey, source, appName}`
 * que gupshup.client.js necesita para mandar/descargar por ESTE canal —
 * PLATFORM o DEDICATED, sin distinción acá (resolveCredentials() ya
 * encapsula esa rama). `source`/`appName` NO son secretos — viven en el
 * propio WhatsAppChannel (`phoneNumber`/`providerAccountId`), no hace falta
 * resolveCredentials() para ellos.
 *
 * PR1: se agrega `appId` (`channel.providerAppId`, tampoco secreto — es el
 * GUID público de la app en Gupshup) para que gupshup.partner.client.js
 * pueda armar la URL de Partner API. gupshup.client.js (Legacy) simplemente
 * ignora este campo extra — no rompe nada de lo que ya funciona.
 *
 * Errores de resolveCredentials() (canal DEDICATED sin ChannelCredentials,
 * apiKeys revocadas, dato cifrado ilegible — todos AppError fail-loud) se
 * propagan tal cual, sin capturar acá — el fail-soft ya existe una capa
 * arriba, en cada call site de channelService (ai.service.js/webhook.service.js/
 * outbound.worker.js), que ya envuelve sendMessage()/sendTemplate()/sendMedia()
 * en try/catch y marca el mensaje/evento como fallido sin relanzar. Esto
 * incluye el caso de un canal YA DECIDIDO para Partner (outboundApi:'partner'):
 * si acá falla, el error sube tal cual — nunca se reintenta silenciosamente
 * por Legacy con una configuración incompleta.
 *
 * @param {import('../whatsappChannel.model')} channel
 * @returns {Promise<{ apiKey: string, source: string, appName: string, appId: string|null }>}
 */
async function resolverCredencialesDeEnvio(channel) {
  const { apiKey } = await channelCredentialsService.resolveCredentials(channel);
  return {
    apiKey,
    source: channel.phoneNumber,
    appName: channel.providerAccountId,
    appId: channel.providerAppId,
  };
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
    // PR2: resolveOutboundMode() puede tirar (outboundApi:'partner' sin
    // providerAppId) — se llama ANTES de resolverCredencialesDeEnvio() a
    // propósito, para no gastar una consulta a ChannelCredentials/Partner
    // API si la configuración del canal ya es inconsistente de entrada.
    const modo = resolveOutboundMode(channel);
    const credenciales = await resolverCredencialesDeEnvio(channel);

    // Único punto de bifurcación Legacy/Partner para TEXTO — la IA
    // (webhook.service.js) y el envío manual (ai.service.js#sendAgentMessage())
    // llegan ACÁ por el mismo camino (channelService.sendMessage()), ninguno
    // de los 2 necesita saber cuál API se usó. Nunca loguea
    // `apiKey`/`Authorization` — solo channelId/appId, ambos públicos.
    if (modo === 'partner') {
      logger.info('[GupshupProvider] outbound via Partner API', {
        channelId: String(channel._id),
        appId: credenciales.appId,
      });
      return gupshupPartnerClient.sendTextMessage(to, text, credenciales);
    }

    logger.info('[GupshupProvider] outbound via Legacy API', {
      channelId: String(channel._id),
    });
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
  async listTemplates(channel) {
    const credentials = await resolverCredencialesDeEnvio(channel);
    return gupshupClient.listTemplates(credentials);
  }

  /**
   * Auditoría de factibilidad de send_media (12/sep/2026), Paso 1: antes,
   * esto llamaba SIEMPRE a gupshupClient (Legacy) sin importar
   * resolveOutboundMode() — hallazgo real, no hipotético: los 3
   * WhatsAppChannel activos en producción hoy (incluido el canal oficial
   * de CREA OS) están en outboundApi:'partner', así que este método corría
   * por un camino que ningún canal real usa. Mismo criterio de bifurcación
   * que sendMessage() (arriba) — único punto de decisión Legacy/Partner,
   * ahora también para media.
   *
   * @param {import('../whatsappChannel.model')} channel
   * @param {string} to
   * @param {{ url: string, type: 'image'|'video'|'document', caption?: string, filename?: string }} media
   */
  async sendMedia(channel, to, media) {
    // Mismo orden que sendMessage(): resolveOutboundMode() ANTES de
    // resolverCredencialesDeEnvio(), para no gastar una consulta a
    // ChannelCredentials/Partner API si la configuración del canal ya es
    // inconsistente (outboundApi:'partner' sin providerAppId).
    const modo = resolveOutboundMode(channel);
    const credenciales = await resolverCredencialesDeEnvio(channel);

    if (modo === 'partner') {
      logger.info('[GupshupProvider] media outbound via Partner API', {
        channelId: String(channel._id),
        appId: credenciales.appId,
        mediaType: media?.type,
      });
      return gupshupPartnerClient.sendMediaMessage(to, media, credenciales);
    }

    // gupshup.client.js (Legacy) solo soporta image/video — 'document'
    // caería en su rama "else" (video), armando un shape roto en silencio.
    // Documento por Legacy queda fuera de alcance del Paso 1 (ningún canal
    // real está en Legacy hoy) — falla explícito en vez de mandar un
    // request que Gupshup rechazaría sin ninguna pista de por qué.
    if (media?.type === 'document') {
      throw new AppError('Envío de documentos por WhatsApp no soportado todavía en el camino Legacy — solo Partner API', 501);
    }

    logger.info('[GupshupProvider] media outbound via Legacy API', {
      channelId: String(channel._id),
      mediaType: media?.type,
    });
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
   * @param {import('../whatsappChannel.model')} channel — el WhatsAppChannel
   *   real ya resuelto para el tenant (channel.service.js#getChannelStatus).
   *   `connected` sigue siendo global (gupshupClient.estaConfigurado(), env
   *   vars) — no depende de este canal puntual, es "¿Gupshup en sí está
   *   operativo?", no "¿este canal existe?" (eso ya lo garantizó el caller:
   *   getChannelForTenant() solo devuelve canales con status:'active').
   *   phoneNumber/connectionType SÍ vienen del canal real — antes esto
   *   devolvía GUPSHUP_PHONE_NUMBER (el número compartido de PLATFORM) sin
   *   importar qué canal fuera, incluso para un WhatsAppChannel DEDICATED
   *   real ya conectado. Bug encontrado auditando Conexiones en
   *   crea-os-ignite — el frontend nunca podía mostrar el número real de un
   *   canal propio porque este endpoint no se lo daba.
   * @returns {Promise<{connected: boolean, provider: string, phoneNumber: string|null, connectionType: string|null}>}
   */
  async getChannelStatus(channel) {
    await channelCredentialsService.resolveCredentials(channel);
    const connected = channel.status === 'active';
    return {
      connected,
      provider: 'gupshup',
      phoneNumber: connected ? channel.phoneNumber : null,
      connectionType: connected ? channel.connectionType : null,
      channelId: channel._id,
      status: channel.status,
    };
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

// Expuesta como propiedad estática (NO como export nombrado aparte) a
// propósito — `module.exports` sigue siendo la clase misma, sin cambiar la
// forma del require() que ya usan channel.service.js/inbound.gateway.js
// (`const GupshupProvider = require(...); new GupshupProvider()`), ninguno
// de los 2 archivos necesita tocarse. Testeable vía
// `GupshupProvider.resolveOutboundMode(...)`.
GupshupProvider.resolveOutboundMode = resolveOutboundMode;

module.exports = GupshupProvider;
