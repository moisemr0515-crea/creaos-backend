// Test real (Jest) de channelOnboardingWebhook.controller.js — incidente del
// 04/sep/2026 (docs/implementation/known-issues.md, Bug 3). Todo mockeado
// (channelOnboardingCompletion.service) — este archivo no toca Mongo real,
// es lógica pura de controller/auth.
process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN = 'secreto-de-prueba-onboarding';

jest.mock('./channelOnboardingCompletion.service');

const channelOnboardingCompletion = require('./channelOnboardingCompletion.service');
const { verify, webhook, ONBOARDING_WEBHOOK_HEADER, verifyOnboardingWebhookAuth } = require('./channelOnboardingWebhook.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

describe('channelOnboardingWebhook.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('ONBOARDING_WEBHOOK_HEADER es un nombre de header estable, distinto del que usa /gupshup a secas', () => {
    expect(ONBOARDING_WEBHOOK_HEADER).toBe('x-gupshup-webhook-secret');
    expect(ONBOARDING_WEBHOOK_HEADER).not.toBe('x-gupshup-webhook-token'); // el de webhook.service.js — nunca deben coincidir
  });

  describe('verify() — GET', () => {
    test('siempre 200 "OK", sin chequear nada', () => {
      const res = mockRes();
      verify({}, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('OK');
    });
  });

  describe('verifyOnboardingWebhookAuth()', () => {
    test('sin GUPSHUP_ONBOARDING_WEBHOOK_TOKEN configurado: siempre false (fail-closed)', () => {
      jest.isolateModules(() => {
        const original = process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN;
        delete process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN;
        const mod = require('./channelOnboardingWebhook.controller');
        expect(mod.verifyOnboardingWebhookAuth({ [mod.ONBOARDING_WEBHOOK_HEADER]: 'cualquier-cosa' })).toBe(false);
        process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN = original;
      });
    });

    test('header ausente: false', () => {
      expect(verifyOnboardingWebhookAuth({})).toBe(false);
    });

    test('header con el valor correcto: true', () => {
      expect(verifyOnboardingWebhookAuth({ [ONBOARDING_WEBHOOK_HEADER]: 'secreto-de-prueba-onboarding' })).toBe(true);
    });

    test('header con un valor distinto (largo distinto incluido): false, nunca explota', () => {
      expect(verifyOnboardingWebhookAuth({ [ONBOARDING_WEBHOOK_HEADER]: 'otro-valor' })).toBe(false);
      expect(verifyOnboardingWebhookAuth({ [ONBOARDING_WEBHOOK_HEADER]: 'x' })).toBe(false);
      expect(verifyOnboardingWebhookAuth({ [ONBOARDING_WEBHOOK_HEADER]: '' })).toBe(false);
    });
  });

  describe('webhook() — POST', () => {
    test('sin credenciales válidas: 401, nunca llama a channelOnboardingCompletion', () => {
      const req = { params: { appId: 'app-123' }, headers: {}, body: {} };
      const res = mockRes();

      webhook(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid credentials' });
      expect(channelOnboardingCompletion.isAccountVerifiedEvent).not.toHaveBeenCalled();
    });

    test('credenciales válidas + payload ACCOUNT_VERIFIED: ACK 200 y dispara handleGupshupAccountVerified(appId) — usa el path param, no el body', async () => {
      channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(true);
      channelOnboardingCompletion.handleGupshupAccountVerified.mockResolvedValue(undefined);

      const req = {
        params: { appId: 'app-123' },
        headers: { [ONBOARDING_WEBHOOK_HEADER]: 'secreto-de-prueba-onboarding' },
        body: { object: 'whatsapp_business_account', gs_app_id: 'otro-id-que-no-importa' },
      };
      const res = mockRes();

      webhook(req, res);
      await Promise.resolve(); // deja correr el .catch() en background

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ received: true });
      expect(channelOnboardingCompletion.handleGupshupAccountVerified).toHaveBeenCalledWith('app-123');
    });

    test('credenciales válidas + payload que NO es ACCOUNT_VERIFIED (ej. el ping de verificación de Gupshup): ACK 200, no-op — nunca llama a handleGupshupAccountVerified', () => {
      channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(false);

      const req = {
        params: { appId: 'app-123' },
        headers: { [ONBOARDING_WEBHOOK_HEADER]: 'secreto-de-prueba-onboarding' },
        body: { evento: 'sandbox-start' },
      };
      const res = mockRes();

      webhook(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ received: true });
      expect(channelOnboardingCompletion.handleGupshupAccountVerified).not.toHaveBeenCalled();
    });

    test('handleGupshupAccountVerified() falla en background: no revienta el proceso, ya se había respondido 200', async () => {
      channelOnboardingCompletion.isAccountVerifiedEvent.mockReturnValue(true);
      channelOnboardingCompletion.handleGupshupAccountVerified.mockRejectedValue(new Error('boom'));

      const req = {
        params: { appId: 'app-123' },
        headers: { [ONBOARDING_WEBHOOK_HEADER]: 'secreto-de-prueba-onboarding' },
        body: { object: 'whatsapp_business_account' },
      };
      const res = mockRes();

      expect(() => webhook(req, res)).not.toThrow();
      await Promise.resolve().then(() => Promise.resolve()); // deja asentar el .catch()

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
