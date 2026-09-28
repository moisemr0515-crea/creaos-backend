jest.mock('bullmq', () => ({ Worker: jest.fn() }));
jest.mock('../../../config/queue', () => ({
  getQueueConnection: jest.fn(() => ({})),
  QUEUE_NAMES: { INDEX_BUSINESS_DOCUMENT: 'index-business-document' },
}));
jest.mock('../pdfIngestion.service', () => ({ procesarDocumento: jest.fn() }));

const { procesarDocumento } = require('../pdfIngestion.service');
const { processIndexJob } = require('./indexBusinessDocument.worker');

describe('indexBusinessDocument.worker', () => {
  test('reconstruye el procesamiento solo con documentId persistido y propaga attempts', async () => {
    procesarDocumento.mockResolvedValue({ documento: { status: 'active' }, chunkCount: 3 });
    const job = {
      data: { documentId: 'doc-1' },
      attemptsMade: 1,
      opts: { attempts: 4 },
    };

    await expect(processIndexJob(job)).resolves.toEqual({ status: 'active', chunkCount: 3 });
    expect(procesarDocumento).toHaveBeenCalledWith('doc-1', { attempt: 2, maxAttempts: 4 });
  });
});
