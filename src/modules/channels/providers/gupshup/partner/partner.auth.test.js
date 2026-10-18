// Test real (Jest, commiteado) de partner.auth.js — PR-02 del blueprint
// CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md.
//
// GUPSHUP_PARTNER_EMAIL/SECRET se setean ANTES de requerir los módulos bajo
// prueba, mismo criterio que channelCredentials.service.test.js con
// CHANNEL_CREDENTIALS_KEY — config/env.js los lee al cargar.
const originalPartnerEmail = process.env.GUPSHUP_PARTNER_EMAIL;
const originalPartnerSecret = process.env.GUPSHUP_PARTNER_SECRET;
process.env.GUPSHUP_PARTNER_EMAIL = 'partner@creaos.test';
process.env.GUPSHUP_PARTNER_SECRET = 'secret-de-prueba';

// Ningún test debe cargar credenciales desde el .env local del desarrollador.
jest.mock('dotenv', () => ({ config: jest.fn() }));

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
  afterAll(() => {
    if (originalPartnerEmail === undefined) delete process.env.GUPSHUP_PARTNER_EMAIL;
    else process.env.GUPSHUP_PARTNER_EMAIL = originalPartnerEmail;
    if (originalPartnerSecret === undefined) delete process.env.GUPSHUP_PARTNER_SECRET;
    else process.env.GUPSHUP_PARTNER_SECRET = originalPartnerSecret;
  });

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

    describe('indicadores del socio (informe 57)', () => {
      const logger = require('../../../../../utils/logger');
      const CLAVES = ['isTpp', 'onboardEnabled', 'enableAppOnboarding', 'enableWallet', 'billingType'];
      const llamadasDeIndicadores = (spy) => spy.mock.calls.filter(([msg]) => String(msg).includes('indicadores del socio'));
      const loginSinCache = (body) => {
        getRedis.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') });
        httpClient.request.mockResolvedValue({ status: 200, body, requestId: 'gsp_x' });
      };

      // Evita que un espía de una prueba que falló a medias contamine a las siguientes.
      afterEach(() => {
        jest.restoreAllMocks();
      });

      test('cache miss: registra EXACTAMENTE los cinco indicadores (raíz) y nada más de la respuesta', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        loginSinCache({
          token: 'jwt-secreto-no-debe-aparecer', id: 99, name: 'Socio', email: 'socio@x.com', phoneNumber: '999',
          contactName: 'Persona', admin: true, isTpp: true, onboardEnabled: false, enableAppOnboarding: true,
          enableWallet: true, billingType: 'PREPAID', enableCustomer: false,
        });

        await partnerAuth.getValidToken();

        const llamadas = llamadasDeIndicadores(spy);
        expect(llamadas).toHaveLength(1);
        const meta = llamadas[0][1];
        expect(Object.keys(meta).sort()).toEqual([...CLAVES].sort());
        expect(meta).toEqual({ isTpp: true, onboardEnabled: false, enableAppOnboarding: true, enableWallet: true, billingType: 'PREPAID' });
        const todo = JSON.stringify(spy.mock.calls);
        for (const secreto of ['jwt-secreto-no-debe-aparecer', 'socio@x.com', 'Persona', '999']) expect(todo).not.toContain(secreto);
      });

      test('valores inesperados o ausentes: marca fija, nunca se copian; billingType solo de una lista cerrada', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        loginSinCache({
          token: 't', isTpp: 'token-falso-123', onboardEnabled: { x: 1 }, enableWallet: 1, billingType: 'a b!@#<script>',
        });

        await partnerAuth.getValidToken();

        const meta = llamadasDeIndicadores(spy)[0][1];
        expect(meta).toEqual({
          isTpp: 'inesperado', onboardEnabled: 'inesperado', enableAppOnboarding: 'ausente', enableWallet: 'inesperado', billingType: 'inesperado',
        });
        expect(JSON.stringify(spy.mock.calls)).not.toContain('token-falso-123');
        expect(JSON.stringify(spy.mock.calls)).not.toContain('<script>');
      });

      test('billingType: se acepta sin importar mayúsculas y se registra el valor canónico; otros textos, números o booleanos son inesperados', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        for (const [entrada, esperado] of [['postpaid', 'POSTPAID'], ['PrePaid', 'PREPAID'], ['CREDITO-PROPIO', 'inesperado'], [7, 'inesperado'], [true, 'inesperado'], [null, 'ausente']]) {
          spy.mockClear();
          loginSinCache({ token: 't', billingType: entrada });
          await partnerAuth.getValidToken();
          expect(llamadasDeIndicadores(spy)[0][1].billingType).toBe(esperado);
        }
      });

      test('no asume la raíz: busca un solo nivel dentro de objetos hijos, indica dónde lo halló y no registra más', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        loginSinCache({
          token: 'jwt-raiz-secreto',
          data: { isTpp: true, billingType: 'prepaid', token: 'jwt-anidado-secreto', email: 'anidado@x.com' },
          enableWallet: true,
          profundo: { nivel2: { onboardEnabled: true } },
          lista: [{ enableAppOnboarding: true }],
        });

        await partnerAuth.getValidToken();

        const meta = llamadasDeIndicadores(spy)[0][1];
        expect(meta).toEqual({
          isTpp: true,
          onboardEnabled: 'ausente', // dos niveles de profundidad: no se busca
          enableAppOnboarding: 'ausente', // dentro de un arreglo: no se busca
          enableWallet: true,
          billingType: 'PREPAID',
          ubicacionNoRaiz: { isTpp: 'data', billingType: 'data' },
        });
        const todo = JSON.stringify(spy.mock.calls);
        for (const secreto of ['jwt-raiz-secreto', 'jwt-anidado-secreto', 'anidado@x.com']) expect(todo).not.toContain(secreto);
      });

      test('respuesta sin objeto o con forma rara: no explota y marca todo como ausente', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        loginSinCache({ token: 'solo-token' });

        await expect(partnerAuth.getValidToken()).resolves.toBe('solo-token');

        expect(llamadasDeIndicadores(spy)[0][1]).toEqual({
          isTpp: 'ausente', onboardEnabled: 'ausente', enableAppOnboarding: 'ausente', enableWallet: 'ausente', billingType: 'ausente',
        });
      });

      test('cache hit: no hace login ni registra indicadores', async () => {
        const spy = jest.spyOn(logger, 'info').mockImplementation(() => {});
        getRedis.mockReturnValue({ get: jest.fn().mockResolvedValue('token-cacheado'), set: jest.fn() });

        await partnerAuth.getValidToken();

        expect(httpClient.request).not.toHaveBeenCalled();
        expect(llamadasDeIndicadores(spy)).toHaveLength(0);
      });

      test('si el registro falla, el login y el cacheo siguen funcionando (control de no regresión)', async () => {
        jest.spyOn(logger, 'info').mockImplementation(() => { throw new Error('logger roto'); });
        const setMock = jest.fn().mockResolvedValue('OK');
        getRedis.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: setMock });
        httpClient.request.mockResolvedValue({ status: 200, body: { token: 'token-ok' }, requestId: 'gsp_x' });

        await expect(partnerAuth.getValidToken()).resolves.toBe('token-ok');
        expect(setMock).toHaveBeenCalledWith(partnerAuth.REDIS_KEY, 'token-ok', 'EX', partnerAuth.TOKEN_TTL_SECONDS);
      });

      test('interruptor apagado (GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED=false): no registra nada y la autenticación y el cacheo son idénticos', async () => {
        let partnerAuthFresh;
        let httpClientFresh;
        let getRedisFresh;
        let loggerFresh;
        const valorOriginal = process.env.GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED;

        jest.isolateModules(() => {
          process.env.GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED = 'false';
          jest.doMock('../gupshup.http.client', () => ({
            ...jest.requireActual('../gupshup.http.client'),
            request: jest.fn(),
          }));
          jest.doMock('../../../../../config/redis');

          httpClientFresh = require('../gupshup.http.client');
          getRedisFresh = require('../../../../../config/redis').getRedis;
          loggerFresh = require('../../../../../utils/logger');
          partnerAuthFresh = require('./partner.auth');
        });
        if (valorOriginal === undefined) delete process.env.GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED;
        else process.env.GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED = valorOriginal;

        const spy = jest.spyOn(loggerFresh, 'info').mockImplementation(() => {});
        const setMock = jest.fn().mockResolvedValue('OK');
        getRedisFresh.mockReturnValue({ get: jest.fn().mockResolvedValue(null), set: setMock });
        httpClientFresh.request.mockResolvedValue({ status: 200, body: { token: 'token-apagado', isTpp: true }, requestId: 'gsp_x' });

        await expect(partnerAuthFresh.getValidToken()).resolves.toBe('token-apagado');

        expect(llamadasDeIndicadores(spy)).toHaveLength(0);
        expect(httpClientFresh.request).toHaveBeenCalledTimes(1);
        expect(setMock).toHaveBeenCalledWith(partnerAuthFresh.REDIS_KEY, 'token-apagado', 'EX', partnerAuthFresh.TOKEN_TTL_SECONDS);
      });
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
        // Vaciar ambas variables simula configuración ausente. dotenv está
        // mockeado, por lo que el resultado no depende del .env local.
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
