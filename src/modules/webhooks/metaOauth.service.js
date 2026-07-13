const crypto = require('crypto');
const { getRedis } = require('../../config/redis');
const { REDIS_KEYS } = require('../../config/constants');
const { AppError } = require('../../middleware/error.middleware');
const WebhookConfig = require('./webhookConfig.model');
const {
  META_APP_ID,
  META_APP_SECRET,
  META_GRAPH_API_VERSION,
  APP_URL,
} = require('../../config/env');

const STATE_TTL_SECONDS = 30 * 60; // 30 minutos — el diálogo de Facebook (login + selección de negocio/página + permisos) puede tardar más de 10
const REDIRECT_URI = `${APP_URL}/api/v1/webhooks/meta/oauth/callback`;
const SCOPES = ['pages_show_list', 'leads_retrieval'].join(',');

// ─── State (CSRF) vía Redis — mismo patrón que refresh tokens en auth.service.js ──

const createState = async (businessId) => {
  const state = crypto.randomBytes(24).toString('hex');
  const redis = getRedis();
  await redis.setex(REDIS_KEYS.OAUTH_STATE(state), STATE_TTL_SECONDS, businessId.toString());
  return state;
};

// De un solo uso: lo lee y lo borra. Retorna null si no existe/expiró/ya se usó.
const consumeState = async (state) => {
  const redis = getRedis();
  const key = REDIS_KEYS.OAUTH_STATE(state);
  const businessId = await redis.get(key);
  if (businessId) await redis.del(key);
  return businessId;
};

// ─── Paso 1: URL del diálogo de autorización ─────────────────────────────────

const getAuthUrl = async (businessId) => {
  if (!META_APP_ID) throw new AppError('META_APP_ID no configurado', 500);

  const state = await createState(businessId);
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES,
    response_type: 'code',
  });

  return `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
};

// ─── Pasos 2-5: intercambio de tokens y datos de la Página ───────────────────

const exchangeCodeForShortLivedToken = async (code) => {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    redirect_uri: REDIRECT_URI,
    code,
  }).toString();

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(json.error?.message || 'token_exchange_failed', 400);
  return json; // { access_token, token_type, expires_in }
};

const exchangeForLongLivedToken = async (shortLivedToken) => {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`);
  url.search = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  }).toString();

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(json.error?.message || 'long_lived_exchange_failed', 400);
  return json; // { access_token, token_type, expires_in }
};

const fetchUserPages = async (longLivedUserToken) => {
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/accounts` +
    `?fields=id,name,access_token&access_token=${longLivedUserToken}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(json.error?.message || 'fetch_pages_failed', 400);
  return json.data || []; // [{ id, name, access_token, ... }]
};

const subscribePageToLeadgen = async (pageId, pageAccessToken) => {
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/subscribed_apps` +
    `?subscribed_fields=leadgen&access_token=${pageAccessToken}`;

  const res = await fetch(url, { method: 'POST' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success !== true) {
    throw new AppError(json.error?.message || 'subscribe_failed', 400);
  }
  return json;
};

// ─── Orquestación completa usada por el callback ─────────────────────────────

const handleCallback = async ({ code, state }) => {
  const businessId = await consumeState(state);
  if (!businessId) throw new AppError('invalid_state', 400);

  const shortLived = await exchangeCodeForShortLivedToken(code);
  const longLived = await exchangeForLongLivedToken(shortLived.access_token);
  const pages = await fetchUserPages(longLived.access_token);

  if (!pages.length) throw new AppError('no_pages_found', 400);

  // V1: se selecciona automáticamente la primera Página. Sin selector aún.
  const page = pages[0];
  await subscribePageToLeadgen(page.id, page.access_token);

  const accessTokenExpiresAt = longLived.expires_in
    ? new Date(Date.now() + longLived.expires_in * 1000)
    : null;

  // Upsert por {business, platform:'meta'} — reconectar actualiza en vez de duplicar.
  // setDefaultsOnInsert genera verifyToken (default del schema) solo si es un insert nuevo.
  const config = await WebhookConfig.findOneAndUpdate(
    { business: businessId, platform: 'meta' },
    {
      $set: {
        accessToken: page.access_token,
        pageId: page.id,
        pageName: page.name,
        accessTokenExpiresAt,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return config;
};

module.exports = { getAuthUrl, handleCallback };
