// Integración (aislada) del cliente HTTP de Gupshup con la cuota global de
// partnerRateLimit.js. fetch y Redis están simulados: no sale NADA a Gupshup.
jest.mock('../../../../config/redis');
jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { getRedis } = require('../../../../config/redis');
const { request, GupshupHttpError, BASE_URL } = require('./gupshup.http.client');
const {
  runWithPartnerPriority, PartnerLocalRateLimitError, PartnerLimiterUnavailableError, PRIORITY,
  BACKGROUND_LIMIT, GLOBAL_LIMIT,
} = require('./partnerRateLimit');

function crearRedisFalso() {
  const estado = { entradas: [], caido: false };
  const redis = {
    eval: jest.fn(async (script, numKeys, key, windowMs, cap, member) => {
      if (estado.caido) throw new Error('Connection is closed');
      const now = Date.now();
      const tope = Number(cap);
      estado.entradas = estado.entradas.filter((e) => e.score > now - Number(windowMs)).sort((a, b) => a.score - b.score);
      const count = estado.entradas.length;
      if (count >= tope) return [0, count, Math.max(estado.entradas[count - tope].score + Number(windowMs) - now, 0)];
      estado.entradas.push({ score: now, member });
      return [1, count + 1, 0];
    }),
  };
  return { redis, estado };
}

const respuesta = (status, body = {}, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

describe('gupshup.http.client + cuota global del Partner API', () => {
  let estado;
  let fetchMock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    const falso = crearRedisFalso();
    estado = falso.estado;
    getRedis.mockReturnValue(falso.redis);
    fetchMock = jest.fn().mockResolvedValue(respuesta(200, { ok: true }));
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('cada solicitud al host del Partner API consume UN cupo global', async () => {
    await request({ method: 'GET', path: '/partner/app/x/waba/info' });
    await request({ method: 'GET', path: '/partner/app/y/waba/info' });

    expect(estado.entradas).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('los reintentos por 429 de Gupshup (interactivo) también consumen cupo: no hay reintentos "gratis"', async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(respuesta(200, { ok: true }));

    await request({ method: 'GET', path: '/partner/app/x/waba/info' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(estado.entradas).toHaveLength(2);
  });

  test('en segundo plano NO hay reintentos del cliente: un 429 de Gupshup sale una sola vez y consume un solo cupo', async () => {
    fetchMock.mockResolvedValue(respuesta(429, {}, { 'retry-after': '0' }));

    const error = await runWithPartnerPriority(PRIORITY.BACKGROUND, () => request({ method: 'GET', path: '/partner/app/x/waba/info' })).catch((e) => e);

    expect(error).toBeInstanceOf(GupshupHttpError);
    expect(error.statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(estado.entradas).toHaveLength(1);
  });

  test('en segundo plano tampoco se reintentan los 5xx (el barrido reprograma por su cuenta)', async () => {
    fetchMock.mockResolvedValue(respuesta(503));

    await expect(runWithPartnerPriority(PRIORITY.BACKGROUND, () => request({ method: 'GET', path: '/partner/app/x/waba/info' })))
      .rejects.toBeInstanceOf(GupshupHttpError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test(`sin cupo en segundo plano la solicitud NO sale: fetch no se invoca y el error es de cuota local (no un GupshupHttpError)`, async () => {
    for (let i = 0; i < BACKGROUND_LIMIT; i += 1) estado.entradas.push({ score: Date.now(), member: `previa${i}` });

    const error = await runWithPartnerPriority(PRIORITY.BACKGROUND, () => request({ method: 'GET', path: '/partner/app/x/waba/info' })).catch((e) => e);

    expect(error).toBeInstanceOf(PartnerLocalRateLimitError);
    expect(error).not.toBeInstanceOf(GupshupHttpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Redis caído en segundo plano: la solicitud NO sale (fail-closed)', async () => {
    estado.caido = true;

    await expect(runWithPartnerPriority(PRIORITY.BACKGROUND, () => request({ method: 'GET', path: '/partner/app/x/waba/info' })))
      .rejects.toBeInstanceOf(PartnerLimiterUnavailableError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Redis caído en el flujo interactivo: la solicitud sale igual (comportamiento previo, sin degradar el onboarding)', async () => {
    estado.caido = true;

    const res = await request({ method: 'GET', path: '/partner/app/x/waba/info' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('otros hosts (Subscription API / mensajería) NO consultan ni consumen la cuota del Partner API', async () => {
    estado.caido = true; // si lo consultara, quedaría en evidencia
    getRedis.mockClear();

    await request({ method: 'GET', path: '/sm/api/v2/subscription/x', baseUrl: 'https://api.gupshup.io' });
    await runWithPartnerPriority(PRIORITY.BACKGROUND, () => request({ method: 'GET', path: '/sm/api/v2/subscription/x', baseUrl: 'https://api.gupshup.io' }));

    expect(getRedis).not.toHaveBeenCalled();
    expect(estado.entradas).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('la ráfaga del onboarding interactivo no pasa del tope global aunque el cliente la dispare toda junta', async () => {
    jest.useFakeTimers();
    try {
      const llamadas = Array.from({ length: 15 }, () => request({ method: 'GET', path: '/partner/app/x/waba/info' }).then(() => 'ok', () => 'rechazada'));
      await jest.advanceTimersByTimeAsync(11 * 1000);
      const resultados = await Promise.all(llamadas);

      expect(resultados.filter((r) => r === 'ok')).toHaveLength(GLOBAL_LIMIT);
      expect(fetchMock).toHaveBeenCalledTimes(GLOBAL_LIMIT);
    } finally {
      jest.useRealTimers();
    }
  });

  test('BASE_URL sigue siendo el host del Partner API', () => {
    expect(BASE_URL).toBe('https://partner.gupshup.io');
  });
});
