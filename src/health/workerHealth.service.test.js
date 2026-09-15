jest.mock('../modules/channels/queues/inbound.queue');
jest.mock('../modules/channels/queues/outbound.queue');
jest.mock('../modules/channels/queues/deadLetter.queue');
jest.mock('../modules/automations/queues/automationSweep.queue');
jest.mock('../modules/automations/queues/automationExecute.queue');

const { QUEUE_NAMES } = require('../config/queue');
const { checkWorkerHealth } = require('./workerHealth.service');

const healthyCore = () => Promise.resolve({
  ok: true,
  dependencies: { mongo: 'up', redis: 'up' },
});
const runningWorkers = {
  inbound: { isRunning: () => true },
  outbound: { isRunning: () => true },
};
const queueProviders = () => Object.fromEntries(Object.values(QUEUE_NAMES).map((name) => [
  name,
  () => ({ getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0 }) }),
]));

describe('healthcheck secundario del worker', () => {
  test('incluye todas las colas, incluida dead-letter, y consumidores activos', async () => {
    const result = await checkWorkerHealth({
      coreHealthProvider: healthyCore,
      queueProviders: queueProviders(),
      workers: runningWorkers,
    });

    expect(result.ok).toBe(true);
    expect(result.queues[QUEUE_NAMES.DEAD_LETTER]).toEqual(expect.objectContaining({ status: 'up' }));
    expect(result.workers).toEqual({ inbound: 'up', outbound: 'up' });
  });

  test('degrada si una cola secundaria o un consumidor no está operativo', async () => {
    const providers = queueProviders();
    providers[QUEUE_NAMES.DEAD_LETTER] = () => ({ getJobCounts: jest.fn().mockRejectedValue(new Error('offline')) });

    const result = await checkWorkerHealth({
      coreHealthProvider: healthyCore,
      queueProviders: providers,
      workers: { ...runningWorkers, outbound: { isRunning: () => false } },
    });

    expect(result.ok).toBe(false);
    expect(result.queues[QUEUE_NAMES.DEAD_LETTER]).toEqual({ status: 'down' });
    expect(result.workers.outbound).toBe('down');
  });

  test('acota una cola que no responde y la reporta como caída', async () => {
    const providers = queueProviders();
    providers[QUEUE_NAMES.OUTBOUND] = () => ({ getJobCounts: () => new Promise(() => {}) });

    const result = await checkWorkerHealth({
      coreHealthProvider: healthyCore,
      queueProviders: providers,
      workers: runningWorkers,
      timeoutMs: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.queues[QUEUE_NAMES.OUTBOUND]).toEqual({ status: 'down' });
  });
});
