// Test real (Jest, commiteado) de partner.auth.js — PR-02 del blueprint
// CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md.
//
// GUPSHUP_PARTNER_EMAIL/SECRET se setean ANTES de requerir los módulos bajo
// prueba, mismo criterio que channelCredentials.service.test.js con
// CHANNEL_CREDENTIALS_KEY — config/env.js los lee al cargar.
process.env.GUPSHUP_PARTNER_EMAIL = 'partner@creaos.test';
process.env.GUPSHUP_PARTNER_SECRET = 'secret-de-prueba';

// Se preserva la clase real GupshupHttpError (para que `instanceof` siga
// funcionando dentro de partner.auth.js) y solo se mockea `request`.
jest.mock('../gupshup.http.client', () => ({
  ...jest.requireActual('../gupshup.http.client'),
  request: jest.fn(),
}));
jest.mock('../../../../../config/redis');

const httpClient = require('../gupshup.http.client');
const { getRedis } = require('../../../../../config/redis');
const partnerAuth = require('./partner.auth');

describe('partner.auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login()', () => {
    test('éxito: devuelve el token y manda email/secret como form', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { token: 'jwt-real', id: 1 }, requestId: 'gsp_x' });

      const result = await partnerAuth.login('a@b.com', 'sec');

      expect(result.token).toBe('jwt-real');
      expect(result.raw).toEqual({ token: 'jwt-real', id: 1 });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '/partner/account/login', form: { email: 'a@b.com', secret: 'sec' }, idempotent: false })
      );
    });

    test('respuesta sin token: AppError 502, respuesta inesperada', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { id: 1 }, requestId: 'gsp_x' });

      await expect(partnerAuth.login('a@b.com', 'sec')).rejects.toMatchObject({ statusCode: 502 });
    });

    test('credenciales inválidas (403 real de Gupshup) se mapean a AppError 401/403 según el status documentado', async () => {
      httpClient.request.mockRejectedValue(
        new httpClient.GupshupHttpError('Gupshup Partner API respondió 403', {
          status: 'client_error', statusCode: 403, body: { message: 'Failed to authenticate' }, requestId: 'gsp_x',
        })
      );

      await expect(partnerAuth.login('a@b.com', 'mal')).rejects.toMatchObject({ statusCode: 403 });
    });

    test('un error que no es GupshupHttpError se propaga tal cual (no se re-envuelve)', async () => {
      const errorRaro = new Error('algo totalmente inesperado');
      httpClient.request.mockRejectedValue(errorRaro);

      await expect(partnerAuth.login('a@b.com', 'sec')).rejects.toBe(errorRaro);
    });
  });

  describe('getValidToken()', () => {
    test('cache hit: devuelve el token cacheado sin llamar a Gupshup', async () => {
      getRedis.mockReturnValue({ get: jest.fn().mockResolvedValue('token-cacheado'), set: jest.fn() });

      const token = await partnerAuth.getValidToken();

      expect(token).toBe('token-cacheado');
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('cache miss: hace login() y cachea el resultado con la key/TTL documentados', async () => {
      const setMock = jest.fn().mockResolvedValue('OK');
      getRedis.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: setMock });
      httpClient.request.mockResolvedValue({ status: 200, body: { token: 'token-nuevo' }, requestId: 'gsp_x' });

      const token = await partnerAuth.getValidToken();

      expect(token).toBe('token-nuevo');
      expect(setMock).toHaveBeenCalledWith(partnerAuth.REDIS_KEY, 'token-nuevo', 'EX', partnerAuth.TOKEN_TTL_SECONDS);
      expect(partnerAuth.REDIS_KEY).toBe('partner:gupshup:auth');
      expect(partnerAuth.TOKEN_TTL_SECONDS).toBe(23 * 60 * 60);
    });

    test('Redis caído en el get: cae a login() sin explotar', async () => {
      getRedis.mockImplementation(() => {
        throw new Error('Redis no está conectado. Llama connectRedis() primero.');
      });
      httpClient.request.mockResolvedValue({ status: 200, body: { token: 'token-sin-cache' }, requestId: 'gsp_x' });

      const token = await partnerAuth.getValidToken();
      expect(token).toBe('token-sin-cache');
    });

    test('Redis caído también al cachear (post-login): no explota, devuelve igual el token', async () => {
      getRedis
        .mockReturnValueOnce({ get: jest.fn().mockResolvedValue(null) }) // primer getRedis(): para el get()
        .mockImplementationOnce(() => { throw new Error('Redis se cayó justo acá'); }); // segundo getRedis(): para el set()
      httpClient.request.mockResolvedValue({ status: 200, body: { token: 'token-x' }, requestId: 'gsp_x' });

      const token = await partnerAuth.getValidToken();
      expect(token).toBe('token-x');
    });

    test('faltan las credenciales de servidor: AppError 500, nunca llega a llamar a Gupshup', async () => {
      let partnerAuthFresh;
      let httpClientFresh;
      let getRedisFresh;

      jest.isolateModules(() => {
        // Vaciar (no `delete`) a propósito: config/env.js vuelve a llamar
        // dotenv.config() al re-requerirse en este registro aislado, y
        // dotenv NUNCA pisa una key que ya existe en process.env (aunque
        // esté vacía) -- pero SÍ la repuebla desde el .env real si la key
        // fue borrada del todo. Si el .env local tiene credenciales reales
        // (como las que se agregaron para la verificación en vivo del
        // hallazgo #1 del contrato), un `delete` haría que este test dejara
        // de simular el escenario "sin configurar" -- silenciosamente
        // volvería a tener las credenciales reales y el test fallaría.
        process.env.GUPSHUP_PARTNER_EMAIL = '';
        process.env.GUPSHUP_PARTNER_SECRET = '';

        jest.doMock('../gupshup.http.client', () => ({
          ...jest.requireActual('../gupshup.http.client'),
          request: jest.fn(),
        }));
        jest.doMock('../../../../../config/redis');

        httpClientFresh = require('../gupshup.http.client');
        getRedisFresh = require('../../../../../config/redis').getRedis;
        partnerAuthFresh = require('./partner.auth');
      });

      getRedisFresh.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: jest.fn() });

      await expect(partnerAuthFresh.getValidToken()).rejects.toMatchObject({ statusCode: 500 });
      expect(httpClientFresh.request).not.toHaveBeenCalled();

      // Restaurados por si algún test posterior en este archivo los necesita.
      process.env.GUPSHUP_PARTNER_EMAIL = 'partner@creaos.test';
      process.env.GUPSHUP_PARTNER_SECRET = 'secret-de-prueba';
    });
  });
});
