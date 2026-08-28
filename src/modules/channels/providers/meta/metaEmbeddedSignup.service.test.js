// Test real (Jest, commiteado) de metaEmbeddedSignup.service.js — PR-04 del
// blueprint maestro (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md
// §21-22). Mockea global.fetch — nunca pega contra Meta real.
process.env.META_APP_ID = 'meta-app-id-de-prueba';
process.env.META_APP_SECRET = 'meta-app-secret-de-prueba';

const { exchangeCode, resolvePhoneNumber } = require('./metaEmbeddedSignup.service');

function mockResponse({ ok, json }) {
  return { ok, json: async () => json };
}

describe('metaEmbeddedSignup.service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('exchangeCode()', () => {
    test('éxito: devuelve el access_token, arma la URL sin redirect_uri', async () => {
      global.fetch.mockResolvedValue(mockResponse({ ok: true, json: { access_token: 'token-real-de-meta' } }));

      const token = await exchangeCode('code-real-de-meta');

      expect(token).toBe('token-real-de-meta');
      const [urlArg] = global.fetch.mock.calls[0];
      expect(urlArg.toString()).toBe(
        'https://graph.facebook.com/v19.0/oauth/access_token?client_id=meta-app-id-de-prueba&client_secret=meta-app-secret-de-prueba&code=code-real-de-meta'
      );
    });

    test('code inválido (no string): AppError 400, no llama a fetch', async () => {
      await expect(exchangeCode(12345)).rejects.toMatchObject({ statusCode: 400 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('code vacío: AppError 400, no llama a fetch', async () => {
      await expect(exchangeCode('')).rejects.toMatchObject({ statusCode: 400 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Meta responde !ok: AppError 502 con el mensaje real de Meta', async () => {
      global.fetch.mockResolvedValue(mockResponse({ ok: false, json: { error: { message: 'Invalid verification code format.' } } }));

      await expect(exchangeCode('code-vencido')).rejects.toMatchObject({
        statusCode: 502,
        message: 'Invalid verification code format.',
      });
    });

    test('Meta responde 200 pero sin access_token: AppError 502 (fail-loud, nunca null en silencio)', async () => {
      global.fetch.mockResolvedValue(mockResponse({ ok: true, json: {} }));

      await expect(exchangeCode('code-cualquiera')).rejects.toMatchObject({ statusCode: 502 });
    });

    test('respuesta no-JSON de Meta: no explota, cae al mensaje genérico de AppError 502', async () => {
      global.fetch.mockResolvedValue({ ok: false, json: async () => { throw new Error('no es json'); } });

      await expect(exchangeCode('code-cualquiera')).rejects.toMatchObject({ statusCode: 502 });
    });

    test('sin META_APP_SECRET configurado: AppError 500, no llega a llamar a fetch', async () => {
      let exchangeCodeFresh;
      jest.isolateModules(() => {
        process.env.META_APP_SECRET = '';
        exchangeCodeFresh = require('./metaEmbeddedSignup.service').exchangeCode;
      });

      await expect(exchangeCodeFresh('code-cualquiera')).rejects.toMatchObject({ statusCode: 500 });
      expect(global.fetch).not.toHaveBeenCalled();

      process.env.META_APP_SECRET = 'meta-app-secret-de-prueba';
    });
  });

  describe('resolvePhoneNumber()', () => {
    test('éxito: filtra por id === phoneNumberId y normaliza a E.164', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({
          ok: true,
          json: {
            data: [
              { id: 'otro-numero', verified_name: 'Otro', display_phone_number: '+51 900 000 000' },
              { id: 'pnid-real', verified_name: 'CREA OS', display_phone_number: '+1 631-555-5556' },
            ],
          },
        })
      );

      const result = await resolvePhoneNumber('waba-real', 'pnid-real', 'token-real');

      expect(result).toEqual({ phoneNumber: '+16315555556', verifiedName: 'CREA OS' });
      const [urlArg] = global.fetch.mock.calls[0];
      expect(urlArg.toString()).toBe('https://graph.facebook.com/v19.0/waba-real/phone_numbers?access_token=token-real');
    });

    test('verified_name ausente: verifiedName viaja null, no explota', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({ ok: true, json: { data: [{ id: 'pnid-real', display_phone_number: '+16315555556' }] } })
      );

      const result = await resolvePhoneNumber('waba-real', 'pnid-real', 'token-real');
      expect(result.verifiedName).toBeNull();
    });

    test('faltan wabaId/phoneNumberId/accessToken: AppError 400, no llama a fetch', async () => {
      await expect(resolvePhoneNumber(null, 'pnid', 'token')).rejects.toMatchObject({ statusCode: 400 });
      await expect(resolvePhoneNumber('waba', null, 'token')).rejects.toMatchObject({ statusCode: 400 });
      await expect(resolvePhoneNumber('waba', 'pnid', null)).rejects.toMatchObject({ statusCode: 400 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Meta responde !ok: AppError 502', async () => {
      global.fetch.mockResolvedValue(mockResponse({ ok: false, json: { error: { message: 'Invalid OAuth access token.' } } }));

      await expect(resolvePhoneNumber('waba-real', 'pnid-real', 'token-vencido')).rejects.toMatchObject({
        statusCode: 502,
        message: 'Invalid OAuth access token.',
      });
    });

    test('phoneNumberId no encontrado entre los números de la WABA: AppError 502, fail-loud (nunca un resultado adivinado)', async () => {
      global.fetch.mockResolvedValue(
        mockResponse({ ok: true, json: { data: [{ id: 'otro-numero-distinto', display_phone_number: '+16315555556' }] } })
      );

      await expect(resolvePhoneNumber('waba-real', 'pnid-que-no-existe', 'token-real')).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringContaining('pnid-que-no-existe'),
      });
    });

    test('data ausente en la respuesta: se trata como lista vacía, AppError 502 (no encontrado)', async () => {
      global.fetch.mockResolvedValue(mockResponse({ ok: true, json: {} }));

      await expect(resolvePhoneNumber('waba-real', 'pnid-real', 'token-real')).rejects.toMatchObject({ statusCode: 502 });
    });
  });
});
