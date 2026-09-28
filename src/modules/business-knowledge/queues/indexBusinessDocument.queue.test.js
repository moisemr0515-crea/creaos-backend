const mongoose = require('mongoose');

const mockJob = {
  getState: jest.fn(),
  retry: jest.fn(),
  remove: jest.fn(),
};
const mockQueue = {
  getJob: jest.fn(),
  add: jest.fn(),
};

jest.mock('bullmq', () => ({ Queue: jest.fn(() => mockQueue) }));
jest.mock('../../../config/queue', () => ({
  getQueueConnection: jest.fn(() => ({})),
  QUEUE_NAMES: { INDEX_BUSINESS_DOCUMENT: 'index-business-document' },
  DEFAULT_JOB_OPTIONS: { attempts: 3 },
}));

const Business = require('../../businesses/business.model');
const BusinessDocument = require('../businessDocument.model');
const BusinessDocumentChunk = require('../businessDocumentChunk.model');
const {
  enqueueIndexBusinessDocument,
  recoverStuckBusinessDocuments,
} = require('./indexBusinessDocument.queue');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_rag_queue_recovery';

describe('indexBusinessDocument.queue durability', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await BusinessDocument.init();
  });

  afterAll(async () => {
    await BusinessDocumentChunk.deleteMany({});
    await BusinessDocument.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQueue.getJob.mockResolvedValue(null);
    mockQueue.add.mockImplementation(async (name, data, opts) => ({ id: opts.jobId, name, data }));
    await BusinessDocumentChunk.deleteMany({});
    await BusinessDocument.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio recovery' });
  });

  const createDocument = (overrides = {}) => BusinessDocument.create({
    business: business._id,
    version: 1,
    sourceAsset: { publicId: 'doc', resourceType: 'raw' },
    sourceText: 'Texto durable suficiente para que la indexación pueda recuperarse sin el payload original.',
    status: 'uploaded',
    ...overrides,
  });

  test('job determinístico: dos enqueues no crean un segundo envío', async () => {
    const document = await createDocument();
    await enqueueIndexBusinessDocument({ documentId: document._id });
    mockJob.getState.mockResolvedValue('waiting');
    mockQueue.getJob.mockResolvedValue(mockJob);
    await enqueueIndexBusinessDocument({ documentId: document._id });

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'index-business-document',
      { documentId: String(document._id) },
      { jobId: String(document._id) }
    );
  });

  test('Redis caído deja enqueue_failed y conserva sourceText para recovery', async () => {
    const document = await createDocument();
    mockQueue.getJob.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(enqueueIndexBusinessDocument({ documentId: document._id })).rejects.toThrow('Redis unavailable');

    const failed = await BusinessDocument.findById(document._id);
    expect(failed.status).toBe('enqueue_failed');
    expect(failed.errorCode).toBe('queue_unavailable');
    expect(failed.sourceText).toContain('Texto durable');
  });

  test('recovery reencola uploaded y processing stale sin duplicar intención', async () => {
    const uploaded = await createDocument();
    const stale = await createDocument({
      version: 2,
      predecessor: uploaded._id,
      status: 'processing',
      processingStartedAt: new Date(Date.now() - 60_000),
    });

    const recovered = await recoverStuckBusinessDocuments({ staleMs: 1_000 });

    expect(recovered).toBe(2);
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect((await BusinessDocument.findById(uploaded._id)).status).toBe('queued');
    expect((await BusinessDocument.findById(stale._id)).status).toBe('queued');
  });
});
