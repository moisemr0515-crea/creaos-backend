// channelOnboardingWebhook.constants.js — separado a propósito de
// channelOnboardingWebhook.controller.js para evitar un require circular:
// channel.controller.js necesita este nombre de header para armar el
// `headers` que le pasa a partnerSubscriptions.subscribeToEvents(), pero
// channelOnboardingWebhook.controller.js requiere
// channelOnboardingCompletion.service.js, que a su vez requiere
// channel.controller.js (para nombreAppGupshup()) — si channel.controller.js
// importara el header directo desde channelOnboardingWebhook.controller.js,
// ese ciclo dejaría a nombreAppGupshup import ado como `undefined` en
// channelOnboardingCompletion.service.js (Node resuelve un require circular
// devolviendo el module.exports parcial del módulo que todavía se está
// cargando). Este archivo no tiene NINGÚN require — no puede formar parte de
// ningún ciclo.
const ONBOARDING_WEBHOOK_HEADER = 'x-gupshup-webhook-secret';

module.exports = { ONBOARDING_WEBHOOK_HEADER };
