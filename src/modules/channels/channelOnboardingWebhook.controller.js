// channelOnboardingWebhook.controller.js — callback DEDICADO para las
// suscripciones de eventos ACCOUNT del flujo de Embedded Signup (canales
// DEDICATED), separado a propósito de /api/v1/webhooks/gupshup
// (webhook.controller.js#gupshupWebhook, webhook.service.js).
//
// Incidente del 04/sep/2026 (docs/implementation/known-issues.md, Bug 3):
// POST /partner/app/{appId}/subscription devolvía 400 "Invalid URL Passed"
// al intentar suscribir /api/v1/webhooks/gupshup como callback — porque ese
// endpoint exige el header GUPSHUP_WEBHOOK_TOKEN en TODO POST entrante
// (webhook.service.js#verifyGupshupAuth()), y el ping de verificación que
// Gupshup dispara al crear la suscripción no tiene forma de conocer ese
// secreto (confirmado en vivo: un POST sin ese header a la URL vieja
// devuelve 401; docs.gupshup.io/docs/webhook-key-points exige 2xx para
// aceptar la URL).
//
// DECISIÓN DE DISEÑO (no la opción de "ACK primero, validar después" sobre
// el endpoint existente): /api/v1/webhooks/gupshup tiene tráfico real de
// producción HOY (canal PLATFORM) y está dentro de la ventana de validación
// de 14 días del Bloque A — no se toca su comportamiento de auth bajo
// ningún concepto. Esta ruta nueva es 100% independiente: token propio
// (GUPSHUP_ONBOARDING_WEBHOOK_TOKEN, ver config/env.js), sin tocar
// GUPSHUP_WEBHOOK_TOKEN ni su alcance.
//
// Cómo Gupshup conoce el secreto: vía el campo `meta` de
// POST /partner/app/{appId}/subscription (partner.subscriptions.js) —
// `{"headers":{"x-gupshup-webhook-secret":"..."}}`, documentado por Gupshup
// como "custom headers... which can be used for authentication", reenviado
// en cada request que Gupshup hace a esta URL (incluido, según toda la
// evidencia reunida, el ping de verificación al crear la suscripción).
//
// Path scoping: la ruta lleva `:appId` (POST /gupshup/onboarding/:appId) —
// a diferencia de /api/v1/webhooks/gupshup (que resuelve el app/tenant a
// partir del payload), acá no hace falta: cada suscripción ya apunta a una
// URL con el appId correcto embebido, así que se usa el path param como
// fuente de verdad para handleGupshupAccountVerified(), no un campo del
// body (más robusto — no depende de que el ping de verificación tenga un
// payload con forma predecible).
const { GUPSHUP_ONBOARDING_WEBHOOK_TOKEN } = require('../../config/env');
const channelOnboardingCompletion = require('./channelOnboardingCompletion.service');
const logger = require('../../utils/logger');
const { ONBOARDING_WEBHOOK_HEADER } = require('./channelOnboardingWebhook.constants');

const crypto = require('crypto');

/**
 * Mismo criterio que webhook.service.js#verifyGupshupAuth() (comparación en
 * tiempo constante, fail-closed si falta el token configurado) pero
 * DUPLICADO acá a propósito, no importado — este módulo no debe depender de
 * webhook.service.js ni tocarlo (ver comentario de arriba). Es una función
 * chica, la duplicación es preferible al acoplamiento entre 2 secretos que
 * deben poder rotar/cambiar de forma completamente independiente.
 */
function verifyOnboardingWebhookAuth(headers) {
  if (!GUPSHUP_ONBOARDING_WEBHOOK_TOKEN) return false;

  const received = headers?.[ONBOARDING_WEBHOOK_HEADER] || '';
  if (!received) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(GUPSHUP_ONBOARDING_WEBHOOK_TOKEN));
  } catch {
    // Largo distinto (timingSafeEqual tira en vez de devolver false) — el
    // valor recibido no matchea, punto.
    return false;
  }
}

/**
 * GET — mismo no-op que webhook.controller.js#gupshupVerify(): algunos
 * flujos de verificación de webhook usan un GET de handshake antes del
 * primer POST. No se confirmó que Gupshup lo necesite para esta ruta en
 * particular, pero responder 200 acá no tiene costo ni riesgo.
 */
const verify = (req, res) => {
  return res.status(200).send('OK');
};

/**
 * POST — recibe el ping de verificación de Gupshup al crear la suscripción,
 * y más adelante el evento real `account-event`/ACCOUNT_VERIFIED (Go-Live).
 * ACK 2xx SIEMPRE que la auth pase, sin importar qué forma tenga el body —
 * docs.gupshup.io/docs/webhook-key-points exige "HTTP_SUCCESS (2xx) con
 * respuesta vacía" y "aceptar el evento de usuario sandbox-start"; no hay
 * ninguna razón para intentar interpretar ese ping como si fuera el evento
 * real. Solo se dispara handleGupshupAccountVerified() cuando el body
 * efectivamente matchea el shape de ACCOUNT_VERIFIED — cualquier otra cosa
 * (el ping de verificación, un evento que no nos interesa) es un no-op
 * silencioso, mismo criterio que gupshupWebhook() con `messages`.
 */
const webhook = (req, res) => {
  if (!verifyOnboardingWebhookAuth(req.headers)) {
    logger.warn('[channelOnboardingWebhook] request sin credenciales válidas', {
      appId: req.params.appId,
      headerPresente: Boolean(req.headers?.[ONBOARDING_WEBHOOK_HEADER]),
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // ACK inmediato — mismo criterio que gupshupWebhook(): procesar en
  // background, nunca dejar a Gupshup esperando el resultado del guardado.
  res.status(200).json({ received: true });

  const { appId } = req.params;
  const payload = req.body;

  if (channelOnboardingCompletion.isAccountVerifiedEvent(payload)) {
    channelOnboardingCompletion.handleGupshupAccountVerified(appId).catch((err) =>
      logger.error('[channelOnboardingWebhook] handleGupshupAccountVerified error:', { message: err.message, stack: err.stack, appId })
    );
    return;
  }

  // Cualquier otro payload (el ping de verificación de Gupshup al crear la
  // suscripción, u otro evento que no nos interesa) — no-op, ya se
  // respondió 2xx arriba.
  logger.info('[channelOnboardingWebhook] payload recibido, no es account-event/ACCOUNT_VERIFIED — no-op', { appId });
};

module.exports = { verify, webhook, ONBOARDING_WEBHOOK_HEADER, verifyOnboardingWebhookAuth };
