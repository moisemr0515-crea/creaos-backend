// Prueba de CABLEADO del barrido de conciliación del onboarding (14/oct/2026):
// demuestra que el proceso automático está realmente conectado al Worker existente
// (cola + job repetible + worker BullMQ + worker.js + health), sin Redis real.
const fs = require('fs');
const path = require('path');

const mockUpsert = jest.fn().mockResolvedValue(undefined);
const mockQueueCtor = jest.fn();
const mockWorkerCtor = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args) => {
    mockQueueCtor(...args);
    return { upsertJobScheduler: mockUpsert, getJobCounts: jest.fn().mockResolvedValue({}) };
  }),
  Worker: jest.fn().mockImplementation((...args) => {
    mockWorkerCtor(...args);
    return { on: jest.fn(), close: jest.fn(), isRunning: () => true };
  }),
}));
jest.mock('../../config/queue', () => ({
  getQueueConnection: jest.fn(() => ({ conexion: 'falsa' })),
  QUEUE_NAMES: {
    INBOUND: 'inbound', OUTBOUND: 'outbound', DEAD_LETTER: 'dead-letter',
    AUTOMATION_SWEEP: 'automation-sweep', AUTOMATION_EXECUTE: 'automation-execute',
    INDEX_BUSINESS_DOCUMENT: 'index-business-document', STOCK_RESERVATION_SWEEP: 'stock-reservation-sweep',
    ONBOARDING_RECONCILE_SWEEP: 'onboarding-reconcile-sweep',
  },
}));
jest.mock('./channelOnboardingReconcileSweep.service', () => ({
  sweepPendingOnboardingSessions: jest.fn().mockResolvedValue({ revisadas: 0 }),
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ENV_REAL = require('../../config/env');

function cargarConEnv(overrides, cargador) {
  let resultado;
  jest.isolateModules(() => {
    jest.doMock('../../config/env', () => ({ ...ENV_REAL, ...overrides }));
    resultado = cargador();
  });
  return resultado;
}

describe('cableado del barrido de conciliación al Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cola + job repetible', () => {
    test('registra UN job repetible idempotente (upsertJobScheduler) en la cola onboarding-reconcile-sweep con el intervalo configurado', async () => {
      const { scheduleOnboardingReconcileSweep } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: true, ONBOARDING_RECONCILE_INTERVAL_MS: 60000, GUPSHUP_PARTNER_EMAIL: 'x', GUPSHUP_PARTNER_SECRET: 'y' },
        () => require('./queues/onboardingReconcileSweep.queue')
      );

      await scheduleOnboardingReconcileSweep();
      await scheduleOnboardingReconcileSweep(); // idempotente: mismo scheduler id

      expect(mockQueueCtor).toHaveBeenCalledTimes(1);
      expect(mockQueueCtor.mock.calls[0][0]).toBe('onboarding-reconcile-sweep');
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      expect(mockUpsert).toHaveBeenCalledWith('onboarding-reconcile-sweep-scheduler', { every: 60000 }, { name: 'sweep' });
    });

    test('con ONBOARDING_RECONCILE_ENABLED=false no programa nada', async () => {
      const { scheduleOnboardingReconcileSweep } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: false },
        () => require('./queues/onboardingReconcileSweep.queue')
      );

      await scheduleOnboardingReconcileSweep();

      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockQueueCtor).not.toHaveBeenCalled();
    });

    test('si faltan GUPSHUP_PARTNER_EMAIL/SECRET en el servicio, programa igual pero avisa en el log', async () => {
      const logger = require('../../utils/logger');
      const { scheduleOnboardingReconcileSweep } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: true, ONBOARDING_RECONCILE_INTERVAL_MS: 60000, GUPSHUP_PARTNER_EMAIL: '', GUPSHUP_PARTNER_SECRET: '' },
        () => require('./queues/onboardingReconcileSweep.queue')
      );

      await scheduleOnboardingReconcileSweep();

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GUPSHUP_PARTNER_EMAIL'));
    });
  });

  describe('worker BullMQ', () => {
    test('se crea sobre la cola correcta con concurrency 1 y su procesador dispara el barrido', async () => {
      const { sweepPendingOnboardingSessions } = require('./channelOnboardingReconcileSweep.service');
      const { startOnboardingReconcileSweepWorker } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: true },
        () => require('./workers/onboardingReconcileSweep.worker')
      );

      const worker = startOnboardingReconcileSweepWorker();

      expect(worker.isRunning()).toBe(true);
      const [nombreCola, procesador, opciones] = mockWorkerCtor.mock.calls[0];
      expect(nombreCola).toBe('onboarding-reconcile-sweep');
      expect(opciones).toMatchObject({ concurrency: 1 });
      expect(opciones.connection).toBeDefined();

      const salida = await procesador({ id: 'job-1' });
      expect(sweepPendingOnboardingSessions).toHaveBeenCalledTimes(1);
      expect(salida).toEqual({ revisadas: 0 });
    });

    test('con el interruptor apagado, un job ya programado no hace nada', async () => {
      const { sweepPendingOnboardingSessions } = require('./channelOnboardingReconcileSweep.service');
      const { processOnboardingReconcileSweepJob } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: false },
        () => require('./workers/onboardingReconcileSweep.worker')
      );

      expect(await processOnboardingReconcileSweepJob({ id: 'j' })).toEqual({ omitido: true });
      expect(sweepPendingOnboardingSessions).not.toHaveBeenCalled();
    });

    test('un error del barrido se propaga (BullMQ lo marca failed) y se registra', async () => {
      const { sweepPendingOnboardingSessions } = require('./channelOnboardingReconcileSweep.service');
      sweepPendingOnboardingSessions.mockRejectedValueOnce(new Error('boom'));
      const { processOnboardingReconcileSweepJob } = cargarConEnv(
        { ONBOARDING_RECONCILE_ENABLED: true },
        () => require('./workers/onboardingReconcileSweep.worker')
      );

      await expect(processOnboardingReconcileSweepJob({ id: 'j' })).rejects.toThrow('boom');
    });
  });

  describe('entrypoint worker.js y health', () => {
    const workerJs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'worker.js'), 'utf8');

    test('worker.js importa, arranca, programa, reporta en health, anuncia y cierra el worker de conciliación', () => {
      expect(workerJs).toMatch(/require\('\.\/src\/modules\/channels\/queues\/onboardingReconcileSweep\.queue'\)/);
      expect(workerJs).toMatch(/require\('\.\/src\/modules\/channels\/workers\/onboardingReconcileSweep\.worker'\)/);
      expect(workerJs).toMatch(/onboardingReconcileSweepWorker\s*=\s*startOnboardingReconcileSweepWorker\(\)/);
      expect(workerJs).toMatch(/await scheduleOnboardingReconcileSweep\(\)/);
      expect(workerJs).toMatch(/onboardingReconcileSweep:\s*onboardingReconcileSweepWorker/);
      expect(workerJs).toMatch(/QUEUE_NAMES\.ONBOARDING_RECONCILE_SWEEP/);
      expect(workerJs).toMatch(/if \(onboardingReconcileSweepWorker\) await onboardingReconcileSweepWorker\.close\(\)/);
    });

    test('la programación ocurre dentro de iniciar() y NO en la API (server.js/app.js)', () => {
      const raiz = path.join(__dirname, '..', '..', '..');
      for (const archivo of ['server.js', 'app.js']) {
        const ruta = path.join(raiz, archivo);
        if (fs.existsSync(ruta)) expect(fs.readFileSync(ruta, 'utf8')).not.toMatch(/OnboardingReconcileSweep/);
      }
    });

    test('el health del worker revisa la cola de conciliación', () => {
      const { DEFAULT_QUEUE_PROVIDERS } = require('../../health/workerHealth.service');
      expect(Object.keys(DEFAULT_QUEUE_PROVIDERS)).toContain('onboarding-reconcile-sweep');
    });
  });
});
