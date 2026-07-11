const { v4: uuidv4 } = require('uuid');
const WebhookConfig = require('./webhookConfig.model');
const webhookService = require('./webhook.service');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');
const { WHATSAPP_VERIFY_TOKEN } = require('../../config/env');
const logger = require('../../utils/logger');

// ─── Public: Meta webhook verification (GET) ─────────────────────────────────

const metaVerify = async (req, res, next) => {
  try {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode !== 'subscribe') return res.status(400).send('Invalid mode');

    const config = await WebhookConfig.findOne({ verifyToken: token, platform: 'meta', isActive: true });
    if (!config) return res.status(403).send('Invalid verify token');

    return res.status(200).send(challenge);
  } catch (err) {
    next(err);
  }
};

// ─── Public: Meta webhook payload (POST) ─────────────────────────────────────

const metaWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-hub-signature-256'] || '';
    const rawBody = req.rawBody;

    if (rawBody && !webhookService.verifyMetaSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Respond 200 immediately — Meta requires fast ACK
    res.status(200).json({ received: true });

    const { object, entry = [] } = req.body;
    if (object !== 'page') return;

    for (const ent of entry) {
      const pageId = ent.id;
      const config = await WebhookConfig.findOne({ pageId, platform: 'meta', isActive: true });
      if (!config) continue;
      await webhookService.processMetaLead(ent, config).catch((err) =>
        console.error('[webhook] Meta processLead error:', err.message)
      );
    }
  } catch (err) {
    next(err);
  }
};

// ─── Public: TikTok webhook verification (GET) ───────────────────────────────

const tiktokVerify = async (req, res, next) => {
  try {
    const { verify_token: token } = req.query;
    const config = await WebhookConfig.findOne({ verifyToken: token, platform: 'tiktok', isActive: true });
    if (!config) return res.status(403).json({ error: 'Invalid verify token' });
    return res.status(200).json({ code: 0, message: 'success', data: { verify_token: token } });
  } catch (err) {
    next(err);
  }
};

// ─── Public: TikTok webhook payload (POST) ───────────────────────────────────

const tiktokWebhook = async (req, res, next) => {
  try {
    const timestamp = req.headers['timestamp'] || '';
    const nonce     = req.headers['nonce'] || '';
    const signature = req.headers['sign'] || '';
    const rawBody   = req.rawBody;

    if (rawBody && !webhookService.verifyTikTokSignature(rawBody, timestamp, nonce, signature)) {
      return res.status(401).json({ code: 40001, message: 'Invalid signature' });
    }

    res.status(200).json({ code: 0, message: 'success' });

    const { advertiser_id: advertiserId, data } = req.body;
    if (!data) return;

    const config = await WebhookConfig.findOne({ adAccountId: advertiserId, platform: 'tiktok', isActive: true });
    if (!config) return;

    await webhookService.processTikTokLead(data, config).catch((err) =>
      console.error('[webhook] TikTok processLead error:', err.message)
    );
  } catch (err) {
    next(err);
  }
};

// ─── Public: WhatsApp Business API verification (GET) ────────────────────────
// Meta envía: hub.mode=subscribe, hub.verify_token=TOKEN, hub.challenge=RETO

const whatsappVerify = (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode !== 'subscribe') {
    return res.status(400).send('Bad Request: hub.mode must be subscribe');
  }

  const expectedToken = WHATSAPP_VERIFY_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return res.status(403).send('Forbidden: verify_token inválido');
  }

  return res.status(200).send(challenge);
};

// ─── Public: WhatsApp Business API messages (POST) ───────────────────────────

const whatsappWebhook = async (req, res, next) => {
  try {
    // ACK inmediato — Meta requiere respuesta < 5s
    res.status(200).json({ received: true });

    const { object, entry = [] } = req.body;
    if (object !== 'whatsapp_business_account') return;

    for (const ent of entry) {
      for (const change of ent.changes || []) {
        if (change.field !== 'messages') continue;

        const { metadata, messages = [], contacts = [] } = change.value || {};
        const phoneNumberId = metadata?.phone_number_id;

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const from    = msg.from;
          const text    = msg.text?.body || '';
          const contact = contacts.find((c) => c.wa_id === from);
          const name    = contact?.profile?.name || from;

          webhookService.processWhatsAppMessage({ phoneNumberId, from, name, text, msgId: msg.id })
            .catch((err) => console.error('[webhook] WhatsApp processMessage error:', err.message));
        }
      }
    }
  } catch (err) {
    next(err);
  }
};

// ─── Public: Gupshup webhook verification (GET) ──────────────────────────────

const gupshupVerify = (req, res) => {
  return res.status(200).send('OK');
};

// ─── Public: Gupshup webhook payload (POST) ──────────────────────────────────

const gupshupWebhook = async (req, res, next) => {
  try {
    // ACK inmediato — procesamos en background
    res.status(200).json({ received: true });

    const payload = req.body;
    const messages = webhookService.parseGupshupPayload(payload);
    if (!messages.length) {
      logger.warn('[webhook] Gupshup: payload sin mensajes de texto reconocibles', { body: payload });
      return;
    }

    const config = await webhookService.findGupshupConfig(payload);
    if (!config) {
      logger.warn('[webhook] Gupshup: no hay WebhookConfig activo que matchee este payload', {
        app: payload.app,
        gsAppId: payload.gs_app_id,
        wabaId: payload.entry?.[0]?.id,
      });
      return;
    }

    for (const msg of messages) {
      webhookService.processGupshupMessage(msg, config.business).catch((err) =>
        logger.error('[webhook] Gupshup processMessage error:', err)
      );
    }
  } catch (err) {
    next(err);
  }
};

// ─── Protected: Manage webhook configs ───────────────────────────────────────

const createConfig = async (req, res, next) => {
  try {
    const { platform, accessToken, pageId, adAccountId, formIds, defaults } = req.body;
    if (!platform) throw new AppError('platform es requerido (meta | tiktok)', 400);

    const config = await WebhookConfig.create({
      business: req.businessId,
      platform,
      accessToken,
      pageId,
      adAccountId,
      formIds,
      defaults,
      verifyToken: uuidv4(),
    });

    return respuestaExito(res, {
      statusCode: 201,
      message: 'Configuración de webhook creada',
      data: { config },
    });
  } catch (err) {
    next(err);
  }
};

const listConfigs = async (req, res, next) => {
  try {
    const configs = await WebhookConfig.find({ business: req.businessId })
      .select('-accessToken')
      .sort({ createdAt: -1 });

    return respuestaExito(res, { message: 'Configuraciones obtenidas', data: { configs } });
  } catch (err) {
    next(err);
  }
};

const getConfig = async (req, res, next) => {
  try {
    const config = await WebhookConfig.findOne({
      _id: req.params.configId,
      business: req.businessId,
    }).select('-accessToken');

    if (!config) throw new AppError('Configuración no encontrada', 404);

    return respuestaExito(res, { message: 'Configuración obtenida', data: { config } });
  } catch (err) {
    next(err);
  }
};

const updateConfig = async (req, res, next) => {
  try {
    const allowed = ['accessToken', 'pageId', 'adAccountId', 'formIds', 'defaults', 'isActive'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const config = await WebhookConfig.findOneAndUpdate(
      { _id: req.params.configId, business: req.businessId },
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-accessToken');

    if (!config) throw new AppError('Configuración no encontrada', 404);

    return respuestaExito(res, { message: 'Configuración actualizada', data: { config } });
  } catch (err) {
    next(err);
  }
};

const deleteConfig = async (req, res, next) => {
  try {
    const config = await WebhookConfig.findOneAndDelete({
      _id: req.params.configId,
      business: req.businessId,
    });
    if (!config) throw new AppError('Configuración no encontrada', 404);

    return respuestaExito(res, { message: 'Configuración eliminada exitosamente', data: null });
  } catch (err) {
    next(err);
  }
};

const testWebhook = async (req, res, next) => {
  try {
    const config = await WebhookConfig.findOne({
      _id: req.params.configId,
      business: req.businessId,
    });
    if (!config) throw new AppError('Configuración no encontrada', 404);

    return respuestaExito(res, {
      message: 'Webhook configurado correctamente',
      data: {
        platform:    config.platform,
        verifyToken: config.verifyToken,
        isActive:    config.isActive,
        metaVerifyUrl:   config.platform === 'meta' ? '/api/v1/webhooks/meta' : undefined,
        tiktokVerifyUrl: config.platform === 'tiktok' ? '/api/v1/webhooks/tiktok' : undefined,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  metaVerify,
  metaWebhook,
  tiktokVerify,
  tiktokWebhook,
  whatsappVerify,
  whatsappWebhook,
  gupshupVerify,
  gupshupWebhook,
  createConfig,
  listConfigs,
  getConfig,
  updateConfig,
  deleteConfig,
  testWebhook,
};
