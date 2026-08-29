// Test real (Jest, commiteado) de webhook.controller.js#gupshupWebhook() —
// PR-06 del blueprint maestro. Foco EXCLUSIVO en la interceptación nueva del
// evento account-event/ACCOUNT_VERIFIED (channelOnboardingCompletion.service.js)
// antes de los 2 caminos de mensajería existentes — no se agrega cobertura
// del resto del archivo (metaWebhook, tiktokWebhook, CRUD de WebhookConfig,
// etc.), que no se tocó en este PR y no tenía tests propios hasta ahora.
//
// webhook.service.js y ../channels/inbound.gateway se mockean enteros — este
// archivo no verifica su lógica interna (fuera de alcance de PR-06), solo que
// gupshupWebhook() los llame o no según corresponda.
jest.mock('./webhook.service');
jest.mock('../channels/inbound.gateway');
jest.mock('../channels/channelOnboardingCompletion.service');

const webhookService = require('./webhook.service');
const inboundGateway = require('../channels/inbound.gateway');
const channelOnboardingCompletion = require('../channels/channelOnboardingCompletion.service');
const logger = require('../../utils/logger');
const { gupshupWebhook } = require('./webhook.controller');

const ACCOUNT_VERIFIED_PAYLOAD = {
  object: 'whatsapp_business_account',
  gs_app_id: 'gs-app-real',
  entry: [
    {
      id: '731055023430007',
      time: 1778737735857,
      changes: [{ field: 'account-event', value: { payload: { status: 'ACCOUNT_VERIFIED' }, type: 'status-event' } }],
    },
  ],
};

const MENSAJERIA_PAYLOAD = {
  object: 'whatsapp_business_account',
  gs_app_id: 'gs-app-real',
  entry: [{ id: 'x', changes: [{ field: 'messages', value: {} }] }],
};

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('webhook.controller#gupshupWebhook() — interceptación de account-event (PR-06)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webhookService.verifyGupshupAuth.mockReturnValue(true);
    webhookService.parseGupshupPayload.mockReturnValue([]);
  });

  test('auth inválida: 401, nunca llega a evaluar el payload', async () => {
    webhookService.verifyGupshupAuth.mockReturnValue(false);

    const req = { headers: {}, body: ACCOUNT_VERIFIED_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(channelOnboardingCompletion.isAccountVerifiedEvent).not.toHaveBeenCalled();
  });

  test('account-event ACCOUNT_VERIFIED: ACK 200 inmediato, delega a handleGupshupAccountVerified(gs_app_id), nunca toca el pipeline de mensajería', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(true);
    channelOnboardingCompletion.handleGupshupAccountVerified.mockResolvedValue(undefined);

    const req = { headers: {}, body: ACCOUNT_VERIFIED_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });

    // Esperar el microtask del fire-and-forget antes de aseverar.
    await Promise.resolve();
    await Promise.resolve();

    expect(channelOnboardingCompletion.isAccountVerifiedEvent).toHaveBeenCalledWith(ACCOUNT_VERIFIED_PAYLOAD);
    expect(channelOnboardingCompletion.handleGupshupAccountVerified).toHaveBeenCalledWith('gs-app-real');
    expect(webhookService.parseGupshupPayload).not.toHaveBeenCalled();
    expect(webhookService.findGupshupConfig).not.toHaveBeenCalled();
    expect(inboundGateway.handle).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('handleGupshupAccountVerified rechaza: se loguea el error, nunca rompe la respuesta ya enviada', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(true);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    channelOnboardingCompletion.handleGupshupAccountVerified.mockRejectedValue(new Error('Mongo caído'));

    const req = { headers: {}, body: ACCOUNT_VERIFIED_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[webhook] channelOnboardingCompletion.handleGupshupAccountVerified error:',
      expect.objectContaining({ message: 'Mongo caído' })
    );
    expect(next).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('payload de mensajería normal (no account-event): sigue el pipeline existente, NO se llama a channelOnboardingCompletion', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(false);
    webhookService.parseGupshupPayload.mockReturnValue([]); // sin mensajes reconocibles -> corta ahí, no hace falta mockear findGupshupConfig

    const req = { headers: {}, body: MENSAJERIA_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(channelOnboardingCompletion.handleGupshupAccountVerified).not.toHaveBeenCalled();
    expect(webhookService.parseGupshupPayload).toHaveBeenCalledWith(MENSAJERIA_PAYLOAD);
  });
});
