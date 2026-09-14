jest.mock('./queues/outbound.queue', () => ({ enqueueOutbound: jest.fn().mockResolvedValue(undefined) }));

const mongoose = require('mongoose');
const OutboundEvent = require('./outboundEvent.model');
const { enqueueOutbound } = require('./queues/outbound.queue');
const {
  isDeliveryReceipt,
  normalizeDeliveryReceipts,
  reconcileDeliveryReceipt,
} = require('./outboundDelivery.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_outbound_delivery_reconciliation';

describe('outboundDelivery.service — receipts y política at-most-once', () => {
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    enqueueOutbound.mockClear();
  });

  const createEvent = (overrides = {}) => OutboundEvent.create({
    channel: new mongoose.Types.ObjectId(),
    tenantId: new mongoose.Types.ObjectId(),
    conversation: new mongoose.Types.ObjectId(),
    sourceInboundEvent: new mongoose.Types.ObjectId(),
    to: '51900000000',
    text: 'Mensaje de prueba',
    status: 'delivery_uncertain',
    providerMessageId: 'gupshup-message-1',
    ...overrides,
  });

  test('reconoce y normaliza receipts message-event sin confundirlos con mensajes inbound', () => {
    const payload = {
      type: 'message-event',
      timestamp: 1700000000000,
      payload: { id: 'wa-id', gsId: 'gupshup-id', type: 'delivered' },
    };
    expect(isDeliveryReceipt(payload)).toBe(true);
    expect(normalizeDeliveryReceipts(payload)).toEqual([expect.objectContaining({
      providerMessageId: 'gupshup-id',
      status: 'delivered',
    })]);
  });

  test('receipt posterior de entrega actualiza el mismo evento a sent sin crear ni encolar otro', async () => {
    const event = await createEvent();
    const payload = { type: 'message-event', payload: { id: event.providerMessageId, type: 'delivered' }, timestamp: Date.now() };

    await reconcileDeliveryReceipt(payload);
    await reconcileDeliveryReceipt(payload); // receipt duplicado: mismo efecto, ningún evento nuevo

    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('sent');
    expect(stored.providerStatus).toBe('delivered');
    expect(await OutboundEvent.countDocuments({ sourceInboundEvent: event.sourceInboundEvent })).toBe(1);
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });

  test('receipt sin correlación no crea eventos ni provoca reenvío', async () => {
    await createEvent();

    await reconcileDeliveryReceipt({
      type: 'message-event',
      payload: { id: 'id-no-correlacionable', type: 'delivered' },
      timestamp: Date.now(),
    });

    expect(await OutboundEvent.countDocuments({})).toBe(1);
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });

  test('confirmación inequívoca de fallo vuelve reintentable el mismo evento y lo encola', async () => {
    const event = await createEvent();
    const payload = { type: 'message-event', payload: { id: event.providerMessageId, type: 'failed' }, timestamp: Date.now() };

    await reconcileDeliveryReceipt(payload);

    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('retryable_failed');
    expect(stored.errorType).toBe('provider_confirmed_failure');
    expect(enqueueOutbound).toHaveBeenCalledWith(event._id);
    expect(await OutboundEvent.countDocuments({ sourceInboundEvent: event.sourceInboundEvent })).toBe(1);
  });

  test('un failed tardío no revierte un evento ya confirmado delivered/read', async () => {
    const event = await createEvent({ status: 'sent', providerStatus: 'delivered' });
    await reconcileDeliveryReceipt({ type: 'message-event', payload: { id: event.providerMessageId, type: 'failed' } });

    expect((await OutboundEvent.findById(event._id)).status).toBe('sent');
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });
});
