// Test real (Jest, commiteado) de partner.subscriptions.js — PR-06 del
// blueprint maestro.
//
// Se preserva la clase real GupshupHttpError (para que `instanceof` siga
// funcionando dentro de partner.subscriptions.js) y solo se mockea
// `request` — nunca pega contra Gupshup real.
jest.mock('../gupshup.http.client', () => ({
  ...jest.requireActual('../gupshup.http.client'),
  request: jest.fn(),
}));

const httpClient = require('../gupshup.http.client');
const partnerSubscriptions = require('./partner.subscriptions');

const APIKEY = 'apikey-real-de-la-app';

function gupshupError(statusCode, body) {
  return new httpClient.GupshupHttpError(`Gupshup respondió ${statusCode}`, {
    status: statusCode >= 500 ? 'server_error' : 'client_error',
    statusCode,
    body,
    requestId: 'gsp_test',
  });
}

describe('partner.subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('subscribeToEvents()', () => {
    test('happy path: POST /partner/app/{appId}/subscription contra partner.gupshup.io, header Authorization (no apikey) — fix del 04/sep/2026', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success' }, requestId: 'gsp_x' });

      const result = await partnerSubscriptions.subscribeToEvents(
        'app-123',
        APIKEY,
        { url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'creaos-account-events', modes: ['ACCOUNT'] }
      );

      expect(result).toEqual({ status: 'success' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/partner/app/app-123/subscription',
          baseUrl: 'https://partner.gupshup.io',
          headers: { Authorization: APIKEY },
          form: { url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'creaos-account-events', version: 3, modes: 'ACCOUNT' },
          idempotent: false,
        })
      );
    });

    test('varios modos: se serializan juntos separados por coma, sin corchetes', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'x', modes: ['ACCOUNT', 'TEMPLATE'],
      });

      expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({ form: expect.objectContaining({ modes: 'ACCOUNT,TEMPLATE' }) }));
    });

    test('version explícito pisa el default (3)', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'x', modes: ['ACCOUNT'], version: 2,
      });

      expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({ form: expect.objectContaining({ version: 2 }) }));
    });

    // Incidente del 04/sep/2026 (docs/implementation/known-issues.md, Bug 3):
    // channel.controller.js necesita pasar un header custom (el secreto de
    // channelOnboardingWebhook.controller.js) que Gupshup reenvía en cada
    // request a `url` — vía el campo `meta` documentado por Gupshup como
    // `{"headers": {...}}`.
    test('con `headers`: se manda `meta` como JSON string con esos headers', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup/onboarding/app-123',
        tag: 'x',
        modes: ['ACCOUNT'],
        headers: { 'x-gupshup-webhook-secret': 'secreto-de-onboarding' },
      });

      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          form: expect.objectContaining({
            meta: JSON.stringify({ headers: { 'x-gupshup-webhook-secret': 'secreto-de-onboarding' } }),
          }),
        })
      );
    });

    test('sin `headers` (o vacío): NO manda `meta` en el form', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'x', modes: ['ACCOUNT'], headers: {},
      });

      const formEnviado = httpClient.request.mock.calls[0][0].form;
      expect(formEnviado).not.toHaveProperty('meta');
    });

    test('sin url: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { tag: 'x', modes: ['ACCOUNT'] })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('sin tag: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', modes: ['ACCOUNT'] })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('modes vacío o ausente: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: [] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x' })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('500 de Gupshup: se mapea a AppError 502 (falla del proveedor)', async () => {
      httpClient.request.mockRejectedValue(gupshupError(500, { message: 'Internal Server Error' }));

      await expect(
        partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
      ).rejects.toMatchObject({ statusCode: 502 });
    });
  });

  // El backoff se retuvo tras el fix del endpoint (04/sep/2026, ver
  // docs/implementation/known-issues.md) como red de seguridad genérica ante
  // un 401 transitorio real — la hipótesis original de "propagación lenta de
  // Gupshup" quedó descartada (el 401 persistía incluso después de 9s y de
  // horas transcurridas contra el endpoint viejo; la causa real era llamar
  // al endpoint equivocado, no un problema de timing).
  describe('subscribeToEvents() — backoff ante un 401 transitorio (red de seguridad genérica, ya no la causa raíz esperada)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // Corre subscribeToEvents() y va destrabando cada delay pendiente en
    // orden — evita que la promesa quede colgada esperando un setTimeout
    // que las fake timers nunca disparan solas.
    async function ejecutarDestrabandoDelays(promesa) {
      for (const ms of partnerSubscriptions.SUBSCRIPTION_401_RETRY_DELAYS_MS) {
        await jest.advanceTimersByTimeAsync(ms);
      }
      return promesa;
    }

    test('401 UNA vez y luego éxito: reintenta y devuelve el body, sin propagar ningún error', async () => {
      httpClient.request
        .mockRejectedValueOnce(gupshupError(401, { message: 'Authentication Failed' }))
        .mockResolvedValueOnce({ status: 200, body: { status: 'success' }, requestId: 'gsp_x' });

      const promesa = partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'],
      });

      const resultado = await ejecutarDestrabandoDelays(promesa);

      expect(resultado).toEqual({ status: 'success' });
      expect(httpClient.request).toHaveBeenCalledTimes(2);
    });

    test('401 persistente en los 4 intentos (1 original + 3 reintentos): se agotan los delays 1s/3s/5s en orden y se mapea a AppError 502, nunca 401', async () => {
      httpClient.request.mockRejectedValue(gupshupError(401, { message: 'Authentication Failed' }));

      const promesa = partnerSubscriptions
        .subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
        .catch((err) => err); // no queremos que el reject dispare un unhandledRejection mientras se destraban los delays

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      const errorFinal = await ejecutarDestrabandoDelays(promesa);

      expect(httpClient.request).toHaveBeenCalledTimes(4); // 1 original + 3 reintentos
      expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toEqual([1000, 3000, 5000]); // orden y valores exactos del backoff progresivo
      expect(errorFinal).toMatchObject({ statusCode: 502 });
      expect(errorFinal.statusCode).not.toBe(401);
    });

    test('400/403/409/429: NUNCA reintenta (no es un problema de timing) — falla en el primer intento', async () => {
      httpClient.request.mockRejectedValue(gupshupError(429, { message: 'Too Many Requests' }));

      await expect(
        partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
      ).rejects.toMatchObject({ statusCode: 429 });

      expect(httpClient.request).toHaveBeenCalledTimes(1);
    });

    test('un error que no es GupshupHttpError (ej. de red) se propaga tal cual, sin reintentar', async () => {
      const errorDeRed = new Error('ECONNRESET');
      httpClient.request.mockRejectedValue(errorDeRed);

      await expect(
        partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
      ).rejects.toBe(errorDeRed);

      expect(httpClient.request).toHaveBeenCalledTimes(1);
    });
  });
});
