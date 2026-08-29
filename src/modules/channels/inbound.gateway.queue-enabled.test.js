// Test real (Jest, commiteado) de inbound.gateway.js — rama
// WHATSAPP_QUEUE_PROCESSING_ENABLED=true (PR-08). Separado de
// inbound.gateway.test.js a propósito: esa variable se destructura una sola
// vez a nivel de módulo en inbound.gateway.js, así que necesita setearse
// ANTES del primer require de este archivo — mismo motivo por el que
// channel.controller.test.js/partner.auth.test.js setean sus env vars al
// principio del archivo en vez de mutar process.env a mitad de un test.
//
// Hoy este valor es 'false' en Railway (el otro archivo cubre ese camino,
// que es el real en producción) — este archivo cubre el contrato completo
// de inbound.gateway.js igual, para el día que se active la cola.
process.env.WHATSAPP_QUEUE_PROCESSING_ENABLED = 'true';

// Mismo motivo que inbound.gateway.test.js: el mockImplementation tiene que
// venir del factory de jest.mock() mismo, antes de que require('./inbound.gateway')
// dispare el `new GupshupProvider()` a nivel de módulo.
const mockNormalizeInboundEvent = jest.fn();
jest.mock('./providers/gupshupProvider', () => jest.fn().mockImplementation(() => ({ normalizeInboundEvent: mockNormalizeInboundEvent })));
jest.mock('../webhooks/webhook.service');
jest.mock('./queues/inbound.queue');

const mongoose = require('mongoose');
const webhookService = require('../webhooks/webhook.service');
const { enqueueInbound } = require('./queues/inbound.queue');
const Business = require('../businesses/business.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const InboundEvent = require('./inboundEvent.model');
const { handle } = require('./inbound.gateway');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_inbound_gateway_queue';

function mensajeNormalizado(overrides = {}) {
  return {
    providerMessageId: 'msg-cola-1',
    from: '51987654321',
    text: 'Hola, quiero info',
    name: 'Lead de prueba',
    channelIdentifiers: { phoneNumberId: 'pnid-gateway-cola' },
    ...overrides,
  };
}

describe('inboundGateway#handle() — rama de cola (WHATSAPP_QUEUE_PROCESSING_ENABLED=true)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await InboundEvent.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await InboundEvent.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    jest.clearAllMocks();
  });

  test('encola en vez de llamar a processGupshupMessage() directo — el InboundEvent queda en "processing", no "processed"', async () => {
    await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000099', phoneNumberId: 'pnid-gateway-cola', status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado()]);
    enqueueInbound.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    expect(webhookService.processGupshupMessage).not.toHaveBeenCalled();
    const event = await InboundEvent.findOne({ providerMessageId: 'msg-cola-1' });
    expect(event.status).toBe('processing'); // el Worker (inbound.worker.js) es quien lo marca 'processed'
    expect(enqueueInbound).toHaveBeenCalledWith(event._id);
  });

  test('enqueueInbound() falla (Redis/BullMQ caído): el InboundEvent queda failed, el error se propaga', async () => {
    await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000098', phoneNumberId: 'pnid-gateway-cola-2', status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({ providerMessageId: 'msg-cola-2', channelIdentifiers: { phoneNumberId: 'pnid-gateway-cola-2' } })]);
    enqueueInbound.mockRejectedValue(new Error('Redis caído'));

    // handle() nunca relanza (aísla el batch) — se confirma que no explota.
    await expect(handle({ object: 'whatsapp_business_account', entry: [{}] })).resolves.toBeUndefined();

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-cola-2' });
    expect(event.status).toBe('failed');
    expect(event.error).toBe('Redis caído');
  });
});
