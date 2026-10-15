// Cliente Redis compartido — recuperación tras interrupciones prolongadas.
// ioredis está simulado (sin red); la validación contra un Redis real vive en las
// pruebas aisladas con Docker documentadas en el informe del incidente.
jest.mock('./env', () => ({ REDIS_URL: 'redis://127.0.0.1:1' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('ioredis', () => {
  const { EventEmitter } = require('events');
  class FakeRedis extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.status = 'wait';
      this.connect = jest.fn(() => FakeRedis.conectar(this));
      this.quit = jest.fn(async () => { this.status = 'end'; });
      this.disconnect = jest.fn(() => { this.status = 'end'; });
      FakeRedis.instancias.push(this);
    }
  }
  FakeRedis.instancias = [];
  FakeRedis.conectar = (cliente) => {
    cliente.status = 'connecting';
    return Promise.resolve().then(() => { cliente.status = 'ready'; cliente.emit('ready'); });
  };
  return FakeRedis;
});

describe('config/redis — reconexión permanente y cliente único', () => {
  let mod;
  let FakeRedis;
  let logger;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    FakeRedis = require('ioredis');
    FakeRedis.instancias = [];
    logger = require('../utils/logger');
    mod = require('./redis');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('política de reintentos', () => {
    test('retryStrategy NUNCA devuelve null/undefined (null = abandonar y quedar en "end"), ni siquiera tras millones de intentos', () => {
      for (const intento of [1, 2, 5, 10, 11, 50, 1000, 1e6]) {
        const espera = mod.retryStrategy(intento);
        expect(typeof espera).toBe('number');
        expect(Number.isFinite(espera)).toBe(true);
      }
    });

    test('la espera crece hasta un tope de ~1 s (+ jitter): ni bucle apretado ni esperas eternas', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(mod.retryStrategy(1)).toBeGreaterThanOrEqual(100);
        expect(mod.retryStrategy(1)).toBeLessThan(300);
        const tope = mod.retryStrategy(1e6);
        expect(tope).toBeGreaterThanOrEqual(1000);
        expect(tope).toBeLessThan(1200);
      }
    });

    test('el cliente se crea con esa política, lazyConnect y comandos que fallan rápido (no se cuelgan en la reconexión)', async () => {
      await mod.connectRedis();
      const { options } = FakeRedis.instancias[0];
      expect(options.retryStrategy).toBe(mod.retryStrategy);
      expect(options.maxRetriesPerRequest).toBe(2);
      expect(options.lazyConnect).toBe(true);
    });
  });

  describe('conexión única (sin duplicados)', () => {
    test('getRedis() antes de conectar lanza el error de siempre', () => {
      expect(() => mod.getRedis()).toThrow('Redis no está conectado');
    });

    test('connectRedis() simultáneo o repetido comparte UNA sola conexión', async () => {
      const [a, b, c] = await Promise.all([mod.connectRedis(), mod.connectRedis(), mod.connectRedis()]);
      const d = await mod.connectRedis();

      expect(FakeRedis.instancias).toHaveLength(1);
      expect(new Set([a, b, c, d]).size).toBe(1);
      expect(mod.getRedis()).toBe(a);
    });

    test('un fallo en el ARRANQUE rechaza, cierra el cliente (sin reintentos zombis) y permite volver a intentar', async () => {
      FakeRedis.conectar = (cliente) => { cliente.status = 'connecting'; return Promise.reject(new Error('Connection is closed.')); };

      await expect(mod.connectRedis()).rejects.toThrow('Connection is closed');

      expect(FakeRedis.instancias[0].disconnect).toHaveBeenCalledTimes(1);
      expect(() => mod.getRedis()).toThrow('Redis no está conectado');

      FakeRedis.conectar = (cliente) => { cliente.status = 'connecting'; return Promise.resolve().then(() => { cliente.status = 'ready'; cliente.emit('ready'); }); };
      await expect(mod.connectRedis()).resolves.toBeDefined();
      expect(FakeRedis.instancias).toHaveLength(2);
    });
  });

  describe('red de seguridad: cliente en estado "end" sin cierre intencional', () => {
    const conectado = async () => {
      const cliente = await mod.connectRedis();
      cliente.connect.mockClear();
      return cliente;
    };

    test('se reanima el MISMO cliente, una sola vez aunque haya muchos getRedis() simultáneos (sin conexiones duplicadas)', async () => {
      const cliente = await conectado();
      let liberar;
      cliente.connect.mockImplementation(() => new Promise((resolve) => { liberar = () => { cliente.status = 'ready'; resolve(); }; }));
      cliente.status = 'end';

      for (let i = 0; i < 50; i += 1) mod.getRedis();

      expect(cliente.connect).toHaveBeenCalledTimes(1);
      expect(FakeRedis.instancias).toHaveLength(1);
      liberar();
      await Promise.resolve();
    });

    test('con enfriamiento: si vuelve a quedar en "end" no reintenta antes de 5 s, y después sí', async () => {
      const cliente = await conectado();
      cliente.connect.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
      cliente.status = 'end';

      mod.getRedis();
      await jest.advanceTimersByTimeAsync(0);
      expect(cliente.connect).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 20; i += 1) mod.getRedis();
      expect(cliente.connect).toHaveBeenCalledTimes(1); // aún en enfriamiento

      await jest.advanceTimersByTimeAsync(5001);
      mod.getRedis();
      expect(cliente.connect).toHaveBeenCalledTimes(2);
    });

    test('NO reanima si el cliente está reconectando, conectando o listo (connect() ahí abriría una conexión paralela)', async () => {
      const cliente = await conectado();
      for (const estado of ['reconnecting', 'connecting', 'connect', 'ready', 'close']) {
        cliente.status = estado;
        mod.getRedis();
      }
      expect(cliente.connect).not.toHaveBeenCalled();
    });

    test('tras disconnectRedis() (cierre intencional) no se reanima nada y getRedis() vuelve a lanzar', async () => {
      const cliente = await conectado();
      await mod.disconnectRedis();

      expect(cliente.quit).toHaveBeenCalledTimes(1);
      expect(() => mod.getRedis()).toThrow('Redis no está conectado');
      expect(cliente.connect).not.toHaveBeenCalled();
    });

    test('disconnectRedis() con la conexión ya caída corta con disconnect() en lugar de fallar', async () => {
      const cliente = await conectado();
      cliente.quit.mockRejectedValue(new Error('Connection is closed.'));

      await expect(mod.disconnectRedis()).resolves.toBeUndefined();

      expect(cliente.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('logs durante una caída prolongada', () => {
    test('50 errores iguales en segundos se registran una vez (más un resumen a los 30 s), no 50', async () => {
      const cliente = await mod.connectRedis();
      for (let i = 0; i < 50; i += 1) cliente.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      expect(logger.error).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30001);
      cliente.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1].join(' ')).toContain('49 iguales omitidos');
    });

    test('al volver Redis tras una interrupción se deja constancia de la reconexión', async () => {
      const cliente = await mod.connectRedis();
      cliente.emit('close');
      cliente.emit('ready');

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('reconectado'));
    });
  });
});
