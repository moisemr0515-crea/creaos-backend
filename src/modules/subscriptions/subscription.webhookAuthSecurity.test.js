const crypto = require('crypto');

const loadService = ({ nodeEnv = 'production', stripeSecret = '', mpSecret = '', constructEvent } = {}) => {
  jest.resetModules();
  const stripeInstance = {
    webhooks: {
      constructEvent: constructEvent || jest.fn().mockReturnValue({ type: 'test.event', data: {} }),
    },
  };
  jest.doMock('stripe', () => jest.fn(() => stripeInstance));
  jest.doMock('../../config/env', () => ({
    NODE_ENV: nodeEnv,
    STRIPE_SECRET_KEY: 'sk_test_unit',
    STRIPE_WEBHOOK_SECRET: stripeSecret,
    MP_ACCESS_TOKEN: 'mp-test-token',
    MP_WEBHOOK_SECRET: mpSecret,
    APP_URL: 'http://localhost:3001',
    FRONTEND_URL: 'http://localhost:5173',
  }));
  return { service: require('./subscription.service'), stripeInstance };
};

describe('autenticación de webhooks de pago', () => {
  test('Stripe: en production delega la verificación al SDK con raw body, firma y secreto', async () => {
    const { service, stripeInstance } = loadService({ stripeSecret: 'whsec_test' });
    const rawBody = Buffer.from('{"type":"test.event"}');

    await expect(service.handleStripeWebhook(rawBody, 'stripe-signature')).resolves.toEqual({
      received: true,
      type: 'test.event',
    });
    expect(stripeInstance.webhooks.constructEvent).toHaveBeenCalledWith(
      rawBody,
      'stripe-signature',
      'whsec_test'
    );
  });

  test('Stripe: firma incorrecta es rechazada por el SDK', async () => {
    const invalidSignature = Object.assign(new Error('Invalid signature'), {
      type: 'StripeSignatureVerificationError',
    });
    const constructEvent = jest.fn(() => { throw invalidSignature; });
    const { service } = loadService({ stripeSecret: 'whsec_test', constructEvent });

    await expect(service.handleStripeWebhook(Buffer.from('{}'), 'incorrecta')).rejects.toBe(invalidSignature);
  });

  test('Stripe: secreto ausente en production falla cerrado', async () => {
    const { service, stripeInstance } = loadService();

    await expect(service.handleStripeWebhook(Buffer.from('{}'), '')).rejects.toMatchObject({ statusCode: 503 });
    expect(stripeInstance.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  test('Mercado Pago: firma correcta se acepta e incorrecta/ausente se rechaza en production', () => {
    const secret = 'mp-webhook-secret';
    const { service } = loadService({ mpSecret: secret });
    const dataId = 'ABC-123';
    const requestId = 'request-1';
    const ts = '1700000000';
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    expect(service.verifyMercadoPagoSignature(dataId, requestId, `ts=${ts},v1=${signature}`)).toBe(true);
    expect(service.verifyMercadoPagoSignature(dataId, requestId, `ts=${ts},v1=incorrecta`)).toBe(false);
    expect(service.verifyMercadoPagoSignature(dataId, requestId, '')).toBe(false);
  });

  test('Mercado Pago: secreto ausente en production se rechaza', () => {
    const { service } = loadService();
    expect(service.verifyMercadoPagoSignature('id', 'request', 'ts=1,v1=cualquiera')).toBe(false);
  });

  test('development/test mantiene el bypass controlado de pagos sin secreto', async () => {
    const { service, stripeInstance } = loadService({ nodeEnv: 'test' });
    const rawBody = Buffer.from('{"type":"test.event","data":{}}');

    await expect(service.handleStripeWebhook(rawBody, '')).resolves.toEqual({ received: true, type: 'test.event' });
    expect(stripeInstance.webhooks.constructEvent).not.toHaveBeenCalled();
    expect(service.verifyMercadoPagoSignature('id', '', '')).toBe(true);
  });
});
