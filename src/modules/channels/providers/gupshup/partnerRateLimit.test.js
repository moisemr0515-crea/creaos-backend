// Prueba aislada del contador global de solicitudes al Partner API de Gupshup
// (partnerRateLimit.js). No hay Redis real: se usa un Redis simulado y COMPARTIDO
// (un solo almacén para "API" y "Worker") cuyo `eval` aplica la misma semántica
// atómica del script Lua (ventana deslizante, mismo reloj para todos). El script
// Lua en sí NO se ejecuta localmente — ver riesgos del informe.
jest.mock('../../../../config/redis');
jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { getRedis } = require('../../../../config/redis');
const logger = require('../../../../utils/logger');
const {
  acquirePartnerSlot,
  runWithPartnerPriority,
  currentPriority,
  PartnerLocalRateLimitError,
  PartnerLimiterUnavailableError,
  PRIORITY,
  REDIS_KEY,
  WINDOW_MS,
  DOCUMENTED_LIMIT,
  GLOBAL_LIMIT,
  BACKGROUND_LIMIT,
  INTERACTIVE_MAX_WAIT_MS,
  COMMAND_TIMEOUT_MS,
  ACQUIRE_SCRIPT,
} = require('./partnerRateLimit');

function crearRedisFalso() {
  const estado = { entradas: [], caido: false };
  const redis = {
    eval: jest.fn(async (script, numKeys, key, windowMs, cap, member) => {
      // Todo el cuerpo es síncrono: igual que un script Lua, no se intercala con nadie.
      if (estado.caido) throw new Error('Connection is closed');
      const now = Date.now();
      const window = Number(windowMs);
      const tope = Number(cap);
      estado.entradas = estado.entradas.filter((e) => e.score > now - window).sort((a, b) => a.score - b.score);
      const count = estado.entradas.length;
      if (count >= tope) {
        const retry = Math.max(estado.entradas[count - tope].score + window - now, 0);
        return [0, count, retry];
      }
      estado.entradas.push({ score: now, member });
      return [1, count + 1, 0];
    }),
  };
  return { redis, estado };
}

describe('partnerRateLimit — cuota global compartida API/Worker', () => {
  let redis;
  let estado;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    ({ redis, estado } = crearRedisFalso());
    getRedis.mockReturnValue(redis);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const enSegundoPlano = (fn) => runWithPartnerPriority(PRIORITY.BACKGROUND, fn);
  // Cuántas solicitudes quedaron registradas en cualquier ventana de 60 s (máximo).
  const maximoEnVentana = () => {
    const scores = estado.entradas.map((e) => e.score);
    return Math.max(0, ...scores.map((t) => scores.filter((s) => s > t - WINDOW_MS && s <= t).length));
  };

  describe('configuración', () => {
    test('deja margen de seguridad bajo el límite documentado y reserva cupo para la API', () => {
      expect(DOCUMENTED_LIMIT).toBe(10);
      expect(GLOBAL_LIMIT).toBeLessThan(DOCUMENTED_LIMIT);
      expect(BACKGROUND_LIMIT).toBeLessThan(GLOBAL_LIMIT);
      expect(GLOBAL_LIMIT - BACKGROUND_LIMIT).toBeGreaterThanOrEqual(3);
      expect(WINDOW_MS).toBe(60 * 1000);
    });

    test('la prioridad por defecto es interactiva y runWithPartnerPriority la cambia solo dentro de su alcance', async () => {
      expect(currentPriority()).toBe(PRIORITY.INTERACTIVE);
      await runWithPartnerPriority(PRIORITY.BACKGROUND, async () => {
        await Promise.resolve();
        expect(currentPriority()).toBe(PRIORITY.BACKGROUND);
      });
      expect(currentPriority()).toBe(PRIORITY.INTERACTIVE);
    });

    test('cada reserva es UNA sola llamada atómica a Redis (un script, una clave) con la ventana y el tope esperados', async () => {
      await acquirePartnerSlot();
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, numKeys, key, ventana, tope, miembro] = redis.eval.mock.calls[0];
      expect(script).toBe(ACQUIRE_SCRIPT);
      expect([numKeys, key, ventana, tope]).toEqual([1, REDIS_KEY, WINDOW_MS, GLOBAL_LIMIT]);
      expect(typeof miembro).toBe('string');
      // Purga + conteo + registro dentro del mismo script, con el reloj de Redis.
      for (const orden of ['TIME', 'ZREMRANGEBYSCORE', 'ZCARD', 'ZADD', 'PEXPIRE']) expect(ACQUIRE_SCRIPT).toContain(orden);
    });
  });

  describe('segundo plano (barrido): tope reducido, sin esperas', () => {
    test(`permite ${BACKGROUND_LIMIT} solicitudes por ventana y rechaza la siguiente de inmediato con 429 local y el tiempo de espera`, async () => {
      for (let i = 0; i < BACKGROUND_LIMIT; i += 1) await enSegundoPlano(() => acquirePartnerSlot());

      const rechazo = await enSegundoPlano(() => acquirePartnerSlot()).catch((e) => e);

      expect(rechazo).toBeInstanceOf(PartnerLocalRateLimitError);
      expect(rechazo.statusCode).toBe(429);
      expect(rechazo.code).toBe('PARTNER_LOCAL_RATE_LIMIT');
      expect(rechazo.retryAfterMs).toBeGreaterThan(0);
      expect(rechazo.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
      expect(estado.entradas).toHaveLength(BACKGROUND_LIMIT); // la rechazada no consumió cupo
    });

    test('el segundo plano jamás deja a la API sin sus cupos reservados', async () => {
      for (let i = 0; i < 20; i += 1) await enSegundoPlano(() => acquirePartnerSlot()).catch(() => {});
      expect(estado.entradas).toHaveLength(BACKGROUND_LIMIT);

      for (let i = 0; i < GLOBAL_LIMIT - BACKGROUND_LIMIT; i += 1) await acquirePartnerSlot(); // la API todavía pasa
      expect(estado.entradas).toHaveLength(GLOBAL_LIMIT);
    });

    test('la ventana es deslizante: pasados 60 s desde la solicitud más antigua se libera cupo', async () => {
      for (let i = 0; i < BACKGROUND_LIMIT; i += 1) await enSegundoPlano(() => acquirePartnerSlot());
      await expect(enSegundoPlano(() => acquirePartnerSlot())).rejects.toBeInstanceOf(PartnerLocalRateLimitError);

      jest.advanceTimersByTime(WINDOW_MS + 1);

      await expect(enSegundoPlano(() => acquirePartnerSlot())).resolves.toBeUndefined();
    });

    test('sin Redis NO sale ninguna solicitud: falla cerrado con 503 (no hay conciliación sin control)', async () => {
      estado.caido = true;

      const error = await enSegundoPlano(() => acquirePartnerSlot()).catch((e) => e);

      expect(error).toBeInstanceOf(PartnerLimiterUnavailableError);
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('PARTNER_LIMITER_UNAVAILABLE');
    });

    test('si getRedis() lanza (Redis nunca conectó) en segundo plano también falla cerrado', async () => {
      getRedis.mockImplementation(() => { throw new Error('Redis no está conectado'); });
      await expect(enSegundoPlano(() => acquirePartnerSlot())).rejects.toBeInstanceOf(PartnerLimiterUnavailableError);
    });
  });

  describe('interactivo (onboarding de la API)', () => {
    test(`hasta ${GLOBAL_LIMIT} solicitudes por ventana pasan sin esperar`, async () => {
      for (let i = 0; i < GLOBAL_LIMIT; i += 1) await acquirePartnerSlot();
      expect(estado.entradas).toHaveLength(GLOBAL_LIMIT);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('con el cupo agotado espera hasta INTERACTIVE_MAX_WAIT_MS y falla con 429 local (no se queda colgada)', async () => {
      for (let i = 0; i < GLOBAL_LIMIT; i += 1) await acquirePartnerSlot();

      const pendiente = acquirePartnerSlot().catch((e) => e);
      await jest.advanceTimersByTimeAsync(INTERACTIVE_MAX_WAIT_MS + 1);

      expect(await pendiente).toBeInstanceOf(PartnerLocalRateLimitError);
    });

    test('si el cupo se libera dentro de la espera máxima, la solicitud pasa', async () => {
      // La más antigua vence en ~5 s: se simula con solicitudes registradas hace 55 s.
      const ahora = Date.now();
      for (let i = 0; i < GLOBAL_LIMIT; i += 1) estado.entradas.push({ score: ahora - 55 * 1000, member: `x${i}` });

      const pendiente = acquirePartnerSlot();
      await jest.advanceTimersByTimeAsync(6000);

      await expect(pendiente).resolves.toBeUndefined();
    });

    test('con Redis caído NO bloquea el onboarding (comportamiento previo): avisa y deja pasar', async () => {
      estado.caido = true;

      await expect(acquirePartnerSlot()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Redis no disponible'), expect.any(Object));
    });
  });

  describe('Redis lento o reconectando: ningún comando deja la solicitud colgada', () => {
    const colgado = () => new Promise(() => {}); // comando atrapado en la cola offline del cliente

    test('en segundo plano, un comando sin respuesta en COMMAND_TIMEOUT_MS falla CERRADO (503) y no sale ninguna solicitud', async () => {
      redis.eval.mockImplementationOnce(colgado);

      const pendiente = enSegundoPlano(() => acquirePartnerSlot()).catch((e) => e);
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 1);

      expect(await pendiente).toBeInstanceOf(PartnerLimiterUnavailableError);
    });

    test('en el flujo interactivo, el mismo comando atascado deja pasar (fail-open) tras COMMAND_TIMEOUT_MS, no tras minutos', async () => {
      redis.eval.mockImplementationOnce(colgado);

      let paso = false;
      const pendiente = acquirePartnerSlot().then(() => { paso = true; });
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS - 1);
      expect(paso).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      await pendiente;

      expect(paso).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Redis no disponible'), expect.any(Object));
    });

    test('una respuesta lenta pero dentro del plazo sí cuenta y se respeta el cupo', async () => {
      redis.eval.mockImplementationOnce(async (...args) => {
        await new Promise((r) => setTimeout(r, COMMAND_TIMEOUT_MS - 500));
        return crearRedisFalso().redis.eval(...args);
      });

      const pendiente = enSegundoPlano(() => acquirePartnerSlot());
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

      await expect(pendiente).resolves.toBeUndefined();
    });

    test('si el cliente Redis aún no existe (getRedis lanza) el plan B es el mismo: fondo cerrado, interactivo abierto', async () => {
      getRedis.mockImplementation(() => { throw new Error('Redis no está conectado'); });

      await expect(enSegundoPlano(() => acquirePartnerSlot())).rejects.toBeInstanceOf(PartnerLimiterUnavailableError);
      await expect(acquirePartnerSlot()).resolves.toBeUndefined();
    });
  });

  describe('concurrencia API + Worker sobre el mismo contador', () => {
    test(`40 solicitudes simultáneas (20 de la API, 20 del Worker): como máximo ${GLOBAL_LIMIT} en la ventana y el Worker nunca más de ${BACKGROUND_LIMIT}`, async () => {
      const resultados = await (async () => {
        const api = Array.from({ length: 20 }, () => acquirePartnerSlot().then(() => 'api', () => 'rechazada'));
        const worker = Array.from({ length: 20 }, () => enSegundoPlano(() => acquirePartnerSlot()).then(() => 'worker', () => 'rechazada'));
        const todas = Promise.all([...api, ...worker]);
        await jest.advanceTimersByTimeAsync(INTERACTIVE_MAX_WAIT_MS + 1);
        return todas;
      })();

      const concedidas = resultados.filter((r) => r !== 'rechazada');
      expect(concedidas.length).toBeLessThanOrEqual(GLOBAL_LIMIT);
      expect(resultados.filter((r) => r === 'worker').length).toBeLessThanOrEqual(BACKGROUND_LIMIT);
      expect(maximoEnVentana()).toBeLessThanOrEqual(GLOBAL_LIMIT);
      expect(estado.entradas.length).toBe(concedidas.length); // todo lo concedido quedó registrado, sin dobles
    });

    test('a lo largo de varios minutos nunca se excede el tope en NINGUNA ventana de 60 s', async () => {
      const pendientes = [];
      // Ráfagas de 12 solicitudes (mezcla de API y Worker) cada 20 s durante 5 minutos.
      for (let tanda = 0; tanda < 15; tanda += 1) {
        for (let i = 0; i < 12; i += 1) {
          const llamada = i % 3 === 0
            ? enSegundoPlano(() => acquirePartnerSlot())
            : acquirePartnerSlot();
          pendientes.push(llamada.catch(() => 'rechazada'));
        }
        await jest.advanceTimersByTimeAsync(20 * 1000);
      }
      await jest.advanceTimersByTimeAsync(INTERACTIVE_MAX_WAIT_MS + 1);
      await Promise.all(pendientes);

      expect(maximoEnVentana()).toBeLessThanOrEqual(GLOBAL_LIMIT);
    });
  });
});
