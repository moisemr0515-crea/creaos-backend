jest.mock('../queues/deadLetter.queue', () => ({ moveToDeadLetter: jest.fn().mockResolvedValue(undefined) }));

const mongoose = require('mongoose');
const { AppError } = require('../../../middleware/error.middleware');
const OutboundEvent = require('../outboundEvent.model');
const Conversation = require('../../ai/conversation.model');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const { processOutboundJob, classifyOutboundError, handleOutboundFailure } = require('./outbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_outbound_recovery_p1_2';

describe('outbound worker — recuperación durable P1-2', () => {
  let tenantId;
  let channelId;
  let conversation;

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    moveToDeadLetter.mockClear();
    await mongoose.connection.dropDatabase();
    tenantId = new mongoose.Types.ObjectId();
    channelId = new mongoose.Types.ObjectId();
    conversation = await Conversation.create({
      business: tenantId,
      tenantId,
      lead: new mongoose.Types.ObjectId(),
      channel: 'whatsapp',
      whatsappChannel: channelId,
      aiEnabled: true,
    });
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
  });

  const createEvent = (overrides = {}) => OutboundEvent.create({
    channel: channelId,
    tenantId,
    conversation: conversation._id,
    sourceInboundEvent: new mongoose.Types.ObjectId(),
    to: '51900000000',
    text: 'Respuesta de prueba',
    status: 'queued',
    ...overrides,
  });

  const jobFor = (event, attemptsMade = 0) => ({
    data: { outboundEventId: event._id },
    attemptsMade,
    opts: { attempts: 3 },
  });

  test.each([
    [Object.assign(new Error('HTTP 503'), { statusCode: 503 }), 'provider_unavailable'],
    [Object.assign(new Error('HTTP 429'), { statusCode: 429 }), 'rate_limit'],
    [Object.assign(new Error('conexión rechazada'), { code: 'ECONNREFUSED' }), 'pre_send_network'],
  ])('clasifica fallos inequívocos 5xx/429/pre-send como retriables', (error, type) => {
    expect(classifyOutboundError(error)).toEqual({ retryable: true, type });
  });

  test('clasifica timeout posterior al inicio del request como entrega incierta', () => {
    const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(classifyOutboundError(error)).toEqual({
      retryable: false,
      uncertain: true,
      type: 'ambiguous_provider_timeout',
    });
  });

  test.each([
    [new AppError('Credencial revocada', 401), 'credentials_or_access'],
    [new AppError('Canal desconectado', 409), 'invalid_request'],
  ])('clasifica credenciales revocadas y canal desconectado como permanentes', (error, type) => {
    expect(classifyOutboundError(error)).toEqual({ retryable: false, type });
  });

  test('un fallo temporal vuelve a ser reclamable y el siguiente intento termina sent', async () => {
    const event = await createEvent();
    const send = jest.spyOn(channelService, 'sendMessage')
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { statusCode: 503 }))
      .mockResolvedValueOnce({ messageId: 'provider-1' });

    await expect(processOutboundJob(jobFor(event, 0))).rejects.toThrow('HTTP 503');
    expect((await OutboundEvent.findById(event._id)).status).toBe('retryable_failed');

    await processOutboundJob(jobFor(event, 1));
    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('sent');
    expect(stored.attemptCount).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('timeout ambiguo termina delivery_uncertain y BullMQ no recibe una excepción para reintentar', async () => {
    const event = await createEvent();
    const send = jest.spyOn(channelService, 'sendMessage').mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
    );

    await expect(processOutboundJob(jobFor(event))).resolves.toBeUndefined();

    const stored = await OutboundEvent.findById(event._id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe('delivery_uncertain');
    expect(stored.errorType).toBe('ambiguous_provider_timeout');
  });

  test('si el proveedor acepta pero falla persistir sent, no reenvía y conserva la referencia como incierta', async () => {
    const event = await createEvent();
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'provider-confirmed-id' });
    const originalSave = OutboundEvent.prototype.save;
    let saveCalls = 0;
    jest.spyOn(OutboundEvent.prototype, 'save').mockImplementation(function saveWithOneFailure(...args) {
      saveCalls += 1;
      if (saveCalls === 2) return Promise.reject(new Error('Mongo temporalmente no disponible'));
      return originalSave.apply(this, args);
    });

    await expect(processOutboundJob(jobFor(event))).resolves.toBeUndefined();

    const stored = await OutboundEvent.findById(event._id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(stored.status).toBe('delivery_uncertain');
    expect(stored.providerMessageId).toBe('provider-confirmed-id');
    expect(stored.errorType).toBe('provider_accepted_persistence_failed');
  });

  test('credencial revocada termina permanentemente y no consume más intentos', async () => {
    const event = await createEvent();
    jest.spyOn(channelService, 'sendMessage').mockRejectedValue(new AppError('Credencial revocada', 401));

    await expect(processOutboundJob(jobFor(event))).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect((await OutboundEvent.findById(event._id)).status).toBe('permanently_failed');
  });

  test('canal desconectado termina permanentemente', async () => {
    const event = await createEvent();
    jest.spyOn(channelService, 'sendMessage').mockRejectedValue(new AppError('Canal desconectado', 409));

    await expect(processOutboundJob(jobFor(event))).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect((await OutboundEvent.findById(event._id)).status).toBe('permanently_failed');
  });

  test('un estado processing recuperado tras caída se envía una vez y un replay posterior es no-op', async () => {
    const event = await createEvent({ status: 'processing' });
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'provider-2' });

    await processOutboundJob(jobFor(event, 1));
    await processOutboundJob(jobFor(event, 2));

    expect(send).toHaveBeenCalledTimes(1);
    expect((await OutboundEvent.findById(event._id)).status).toBe('sent');
  });

  test('una caída en estado sending no reenvía a ciegas y deja entrega incierta visible', async () => {
    const event = await createEvent({ status: 'sending' });
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'no-debe-usarse' });

    await processOutboundJob(jobFor(event, 1));

    const stored = await OutboundEvent.findById(event._id);
    expect(send).not.toHaveBeenCalled();
    expect(stored.status).toBe('delivery_uncertain');
    expect(stored.errorType).toBe('ambiguous_delivery');
  });

  test('al agotar intentos mueve a dead-letter y deja estado terminal controlado', async () => {
    const event = await createEvent({ status: 'retryable_failed', errorType: 'provider_unavailable' });
    const error = Object.assign(new Error('HTTP 503'), { statusCode: 503 });

    await handleOutboundFailure(jobFor(event, 3), error);

    expect(moveToDeadLetter).toHaveBeenCalledTimes(1);
    expect((await OutboundEvent.findById(event._id)).status).toBe('permanently_failed');
  });
});
