const mockJobs = new Map();
const mockAdd = jest.fn(async (_name, data, options) => {
  if (mockJobs.has(options.jobId)) return mockJobs.get(options.jobId);
  const job = {
    id: options.jobId,
    data,
    getState: jest.fn().mockResolvedValue('waiting'),
    retry: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  mockJobs.set(options.jobId, job);
  return job;
});
const mockGetJob = jest.fn(async (id) => mockJobs.get(id) || null);

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({ add: mockAdd, getJob: mockGetJob })),
}));
jest.mock('../../../config/queue', () => ({
  getQueueConnection: jest.fn(() => ({})),
  QUEUE_NAMES: { OUTBOUND: 'whatsapp-outbound' },
  DEFAULT_JOB_OPTIONS: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
}));
jest.mock('../outboundEvent.model', () => ({
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  find: jest.fn(),
}));

const OutboundEvent = require('../outboundEvent.model');
const { enqueueOutbound, recoverPendingOutboundEvents } = require('./outbound.queue');

describe('outbound.queue — job determinístico y recuperación', () => {
  beforeEach(() => {
    mockJobs.clear();
    mockAdd.mockClear();
    mockGetJob.mockClear();
    OutboundEvent.updateOne.mockClear();
    OutboundEvent.find.mockReset();
  });

  test('dos encolados del mismo OutboundEvent usan un único jobId y no crean jobs duplicados', async () => {
    await enqueueOutbound('64b000000000000000000001');
    await enqueueOutbound('64b000000000000000000001');

    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(
      'process-outbound',
      { outboundEventId: '64b000000000000000000001' },
      { jobId: '64b000000000000000000001' }
    );
  });

  test('un job BullMQ fallido existente se reactiva en vez de crear otro', async () => {
    const failedJob = {
      id: '64b000000000000000000002',
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    mockJobs.set(failedJob.id, failedJob);

    await enqueueOutbound(failedJob.id);

    expect(failedJob.retry).toHaveBeenCalledTimes(1);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('si BullMQ falla, el OutboundEvent queda marcado enqueue_failed y el error se propaga', async () => {
    mockAdd.mockRejectedValueOnce(new Error('Redis no disponible'));

    await expect(enqueueOutbound('64b000000000000000000003')).rejects.toThrow('Redis no disponible');
    expect(OutboundEvent.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: '64b000000000000000000003' }),
      { $set: expect.objectContaining({ status: 'enqueue_failed', errorType: 'queue_unavailable' }) }
    );
  });

  test('el barrido de arranque recupera pending/enqueue_failed sin recrear el evento', async () => {
    const events = [
      { _id: '64b000000000000000000004', tenantId: 'tenant-1', channel: 'channel-1', status: 'pending' },
      { _id: '64b000000000000000000005', tenantId: 'tenant-1', channel: 'channel-1', status: 'enqueue_failed' },
    ];
    const query = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(events),
    };
    OutboundEvent.find.mockReturnValue(query);

    await expect(recoverPendingOutboundEvents()).resolves.toBe(2);
    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(OutboundEvent.find).toHaveBeenCalledWith({
      status: { $in: ['pending', 'enqueue_failed', 'queued', 'retryable_failed'] },
    });
  });
});
