// Test real (Jest, commiteado) de gupshup.http.client.js — PR-02 del
// blueprint CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md.
//
// Mockea global.fetch — nunca pega contra Gupshup real. Los delays de
// backoff son reales (no fake timers) pero acotados: cada test que ejercita
// un retry usa maxRetries:1, así el peor caso es un solo RETRY_BASE_DELAY_MS
// (500ms), no la cadena completa de 3 reintentos.
const logger = require('../../../../utils/logger');
const { request, GupshupHttpError } = require('./gupshup.http.client');

describe('gupshup.http.client#request()', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockResponse({ status, body, headers = {} }) {
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    };
  }

  test('GET exitoso: devuelve status/body parseado/requestId', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: { ok: true } }));

    const result = await request({ method: 'GET', path: '/partner/app/123/obotoembed/verify' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.requestId).toMatch(/^gsp_/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('arma la URL con base host + path, y query params si vienen', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));

    await request({ method: 'GET', path: '/partner/app/x/y', query: { user: 'abc', lang: 'es', regenerate: undefined } });

    const [urlArg] = global.fetch.mock.calls[0];
    expect(urlArg.toString()).toBe('https://partner.gupshup.io/partner/app/x/y?user=abc&lang=es');
  });

  test('form body: content-type x-www-form-urlencoded y body codificado', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: { appId: 'abc' } }));

    await request({ method: 'POST', path: '/partner/app', headers: { token: 'jwt-x' }, form: { name: 'Mi App', templateMessaging: false } });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('name=Mi+App&templateMessaging=false');
  });

  test('nunca loguea el header token ni authorization en texto plano', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));

    await request({ method: 'GET', path: '/partner/app/x/obotoembed/verify', headers: { token: 'jwt-secreto', Authorization: 'Bearer otro-secreto', 'X-Otra-Cosa': 'visible' } });

    const llamadaConHeaders = infoSpy.mock.calls.find(([, meta]) => meta?.headers);
    expect(llamadaConHeaders[1].headers.token).toBe('[REDACTED]');
    expect(llamadaConHeaders[1].headers.Authorization).toBe('[REDACTED]');
    expect(llamadaConHeaders[1].headers['X-Otra-Cosa']).toBe('visible');

    infoSpy.mockRestore();
  });

  test('nunca loguea el header apikey en texto plano (PR-06, Subscription API)', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));

    await request({ method: 'POST', path: '/wa/app/x/subscription', baseUrl: 'https://api.gupshup.io', headers: { apikey: 'apikey-secreto' } });

    const llamadaConHeaders = infoSpy.mock.calls.find(([, meta]) => meta?.headers);
    expect(llamadaConHeaders[1].headers.apikey).toBe('[REDACTED]');

    infoSpy.mockRestore();
  });

  test('baseUrl override: arma la URL contra otro host, no partner.gupshup.io (PR-06, Subscription API)', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));

    await request({ method: 'POST', path: '/wa/app/x/subscription', baseUrl: 'https://api.gupshup.io' });

    const [urlArg] = global.fetch.mock.calls[0];
    expect(urlArg.toString()).toBe('https://api.gupshup.io/wa/app/x/subscription');
  });

  test('sin baseUrl explícito, sigue usando el host de partner.gupshup.io de siempre', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));

    await request({ method: 'GET', path: '/partner/app/x' });

    const [urlArg] = global.fetch.mock.calls[0];
    expect(urlArg.toString()).toBe('https://partner.gupshup.io/partner/app/x');
  });

  test('400 (client_error): nunca reintenta, propaga GupshupHttpError con body', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 400, body: { message: 'Invalid characters used in app name' } }));

    await expect(request({ method: 'POST', path: '/partner/app', form: { name: 'x' } })).rejects.toMatchObject({
      name: 'GupshupHttpError',
      status: 'client_error',
      statusCode: 400,
      body: { message: 'Invalid characters used in app name' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('429: siempre reintenta (incluso en POST), y respeta Retry-After si viene', async () => {
    global.fetch
      .mockResolvedValueOnce(mockResponse({ status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: { appId: 'abc' } }));

    const result = await request({ method: 'POST', path: '/partner/app', form: { name: 'x' }, maxRetries: 1 });

    expect(result.body).toEqual({ appId: 'abc' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('5xx en GET (idempotente): reintenta y termina en éxito', async () => {
    global.fetch
      .mockResolvedValueOnce(mockResponse({ status: 500, body: { message: 'Internal Server Error' } }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: { status: 'success' } }));

    const result = await request({ method: 'GET', path: '/partner/app/x/obotoembed/verify', maxRetries: 1 });

    expect(result.body).toEqual({ status: 'success' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('5xx en POST (NO idempotente): no reintenta, propaga de una', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse({ status: 500, body: { message: 'Unable to create App' } }));

    await expect(request({ method: 'POST', path: '/partner/app', form: { name: 'x' }, maxRetries: 3 })).rejects.toMatchObject({
      status: 'server_error',
      statusCode: 500,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('5xx agota los reintentos: termina propagando el último error tal cual (server_error, no network_error)', async () => {
    global.fetch.mockResolvedValue(mockResponse({ status: 500, body: { message: 'sigue caído' } }));

    await expect(request({ method: 'GET', path: '/x', maxRetries: 1 })).rejects.toMatchObject({
      status: 'server_error',
      statusCode: 500,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2); // intento inicial + 1 reintento
  });

  test('error de red en GET (idempotente): reintenta y termina en éxito', async () => {
    global.fetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: { status: 'success' } }));

    const result = await request({ method: 'GET', path: '/partner/app/x/obotoembed/verify', maxRetries: 1 });

    expect(result.body).toEqual({ status: 'success' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('error de red en POST (NO idempotente): no reintenta, propaga GupshupHttpError network_error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(request({ method: 'POST', path: '/partner/app', form: { name: 'x' }, maxRetries: 3 })).rejects.toMatchObject({
      status: 'network_error',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('idempotent:true explícito fuerza el retry aunque el método sea POST', async () => {
    global.fetch
      .mockResolvedValueOnce(mockResponse({ status: 500, body: {} }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: { status: 'success' } }));

    const result = await request({ method: 'POST', path: '/partner/app/x/obotoembed/verify', idempotent: true, maxRetries: 1 });

    expect(result.body).toEqual({ status: 'success' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('respuesta no-JSON no rompe — devuelve el texto crudo', async () => {
    global.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => 'no soy json',
      headers: { get: () => null },
    });

    const result = await request({ method: 'GET', path: '/x' });
    expect(result.body).toBe('no soy json');
  });

  test('GupshupHttpError expone status/statusCode/body/requestId', () => {
    const err = new GupshupHttpError('mensaje', { status: 'client_error', statusCode: 400, body: { a: 1 }, requestId: 'gsp_x' });
    expect(err.name).toBe('GupshupHttpError');
    expect(err.status).toBe('client_error');
    expect(err.statusCode).toBe(400);
    expect(err.body).toEqual({ a: 1 });
    expect(err.requestId).toBe('gsp_x');
    expect(err).toBeInstanceOf(Error);
  });
});
