// Test real (Jest, commiteado) de webhook.controller.js#gupshupWebhook() —
// PR-06 del blueprint maestro. Foco EXCLUSIVO en la interceptación del
// evento account-event/ACCOUNT_VERIFIED (channelOnboardingCompletion.service.js)
// antes del pipeline de mensajería — no se agrega cobertura del resto del
// archivo (metaWebhook, tiktokWebhook, CRUD de WebhookConfig, etc.), que no
// se tocó en este PR y no tenía tests propios hasta ahora.
//
// Fase 1.f (docs/implementation/known-issues.md): inbound.gateway.js es
// desde acá el único pipeline de mensajería — se retiró el feature flag
// WHATSAPP_CHANNEL_CORE_ENABLED y el camino legacy (parseGupshupPayload()/
// findGupshupConfig()) tras la ventana de validación de 14+ días.
//
// webhook.service.js y ../channels/inbound.gateway se mockean enteros — este
// archivo no verifica su lógica interna (fuera de alcance de PR-06), solo que
// gupshupWebhook() los llame o no según corresponda.
jest.mock('./webhook.service');
jest.mock('../channels/inbound.gateway');
jest.mock('../channels/channelOnboardingCompletion.service');
jest.mock('../channels/outboundDelivery.service');

const webhookService = require('./webhook.service');
const inboundGateway = require('../channels/inbound.gateway');
const channelOnboardingCompletion = require('../channels/channelOnboardingCompletion.service');
const outboundDeliveryService = require('../channels/outboundDelivery.service');
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
    inboundGateway.handle.mockResolvedValue(undefined);
    outboundDeliveryService.isDeliveryReceipt.mockReturnValue(false);
    outboundDeliveryService.reconcileDeliveryReceipt.mockResolvedValue([]);
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
    expect(inboundGateway.handle).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('handleGupshupAccountVerified rechaza: no responde 2xx y delega al middleware de error', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(true);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    channelOnboardingCompletion.handleGupshupAccountVerified.mockRejectedValue(new Error('Mongo caído'));

    const req = { headers: {}, body: ACCOUNT_VERIFIED_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Mongo caído' }));

    errorSpy.mockRestore();
  });

  test('payload de mensajería normal (no account-event): ACK 200, delega a inboundGateway.handle(), NO se llama a channelOnboardingCompletion', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(false);

    const req = { headers: {}, body: MENSAJERIA_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(channelOnboardingCompletion.handleGupshupAccountVerified).not.toHaveBeenCalled();
    expect(inboundGateway.handle).toHaveBeenCalledWith(MENSAJERIA_PAYLOAD);
  });

  test('message-event de delivery se reconcilia y nunca entra al pipeline inbound', async () => {
    const receipt = { type: 'message-event', payload: { id: 'gs-message-id', type: 'delivered' } };
    outboundDeliveryService.isDeliveryReceipt.mockReturnValue(true);

    const res = mockRes();
    const next = jest.fn();
    await gupshupWebhook({ headers: {}, body: receipt }, res, next);

    expect(outboundDeliveryService.reconcileDeliveryReceipt).toHaveBeenCalledWith(receipt);
    expect(inboundGateway.handle).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test('no envía ACK hasta que la persistencia/encolado durable confirma', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(false);
    let release;
    inboundGateway.handle.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const res = mockRes();
    const pending = gupshupWebhook({ headers: {}, body: MENSAJERIA_PAYLOAD }, res, jest.fn());
    await Promise.resolve();
    expect(res.status).not.toHaveBeenCalled();
    release();
    await pending;
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('inboundGateway.handle() rechaza: no responde 2xx y delega al middleware de error', async () => {
    channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(false);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    inboundGateway.handle.mockRejectedValue(new Error('Mongo caído'));

    const req = { headers: {}, body: MENSAJERIA_PAYLOAD };
    const res = mockRes();
    const next = jest.fn();

    await gupshupWebhook(req, res, next);
    await Promise.resolve();
    await Promise.resolve();

    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Mongo caído' }));

    errorSpy.mockRestore();
  });
});
