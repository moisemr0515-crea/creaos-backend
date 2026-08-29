// Test real (Jest, commiteado) de inbound.gateway.js — PR-08 del blueprint
// maestro. Este archivo (el orquestador real: channelResolver → tenantResolver
// → InboundEvent → processGupshupMessage/enqueueInbound) no tenía NINGÚN test
// hasta este PR, a pesar de ser el camino que corre HOY en producción para
// todo mensaje real de WhatsApp (WHATSAPP_CHANNEL_CORE_ENABLED=true en
// Railway) — confirmado durante la investigación de si el camino de entrada
// ya soporta canales DEDICATED (PR-06) sin cambios de lógica.
//
// WHATSAPP_QUEUE_PROCESSING_ENABLED se deja en su default (false) en este
// archivo — es el valor real de Railway hoy, y es el camino que este archivo
// cubre: llamada SÍNCRONA a webhookService.processGupshupMessage(), sin
// BullMQ de por medio. El caso `true` (encolar) se cubre aparte en
// inbound.gateway.queue-enabled.test.js — se separó en 2 archivos a
// propósito: WHATSAPP_QUEUE_PROCESSING_ENABLED se destructura una sola vez a
// nivel de módulo en inbound.gateway.js, y recargar ese módulo a mitad de un
// archivo (jest.resetModules()/isolateModules()) arrastraría también a
// InboundEvent.model.js (mongoose.model()) a una instancia de mongoose
// desconectada — mismo riesgo ya documentado en channel.controller.test.js
// (PR-07a).
//
// channelResolver/channelRepository/tenantResolver NO se mockean — corren
// reales contra Mongo, que es justamente lo que hace falta probar de punta a
// punta. Se mockean solo los 2 bordes externos: gupshupProvider
// (normalización del payload — no es lo que se está probando acá, ya tiene
// sus propios tests) y webhookService/inbound.queue (efectos aguas abajo,
// también con sus propios tests).
// inbound.gateway.js hace `new GupshupProvider()` UNA VEZ a nivel de módulo
// (al requerirse) — el mock tiene que devolver el objeto de siempre desde el
// factory de jest.mock() mismo, ANTES de que `require('./inbound.gateway')`
// dispare esa instanciación. Poner el mockImplementation() después de ese
// require (como en un primer intento de este archivo) llega tarde: el
// automock por defecto ya quedó instanciado con un normalizeInboundEvent que
// no es este mock, y todo devuelve undefined en silencio.
const mockNormalizeInboundEvent = jest.fn();
jest.mock('./providers/gupshupProvider', () => jest.fn().mockImplementation(() => ({ normalizeInboundEvent: mockNormalizeInboundEvent })));
jest.mock('../webhooks/webhook.service');
jest.mock('./queues/inbound.queue');

const mongoose = require('mongoose');
const webhookService = require('../webhooks/webhook.service');
const Business = require('../businesses/business.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const InboundEvent = require('./inboundEvent.model');
const logger = require('../../utils/logger');
const { handle } = require('./inbound.gateway');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_inbound_gateway';

function mensajeNormalizado(overrides = {}) {
  return {
    providerMessageId: 'msg-1',
    from: '51987654321',
    text: 'Hola, quiero info',
    name: 'Lead de prueba',
    channelIdentifiers: { phoneNumberId: 'pnid-gateway-dedicado' },
    ...overrides,
  };
}

describe('inboundGateway#handle() — camino síncrono real (WHATSAPP_QUEUE_PROCESSING_ENABLED=false, valor de Railway hoy)', () => {
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
    // clearAllMocks() limpia calls/results pero NO el mockImplementation de
    // GupshupProvider (eso sobrevive, fijado una sola vez arriba) — cada
    // test de todos modos setea explícito su propio mockNormalizeInboundEvent
    // .mockReturnValue(...) antes de usarlo, así que no hay fuga real entre tests.
    jest.clearAllMocks();
  });

  // Caso explícito pedido: un mensaje entrante llega a un WhatsAppChannel
  // DEDICATED (no PLATFORM) y se procesa de punta a punta.
  test('DEDICATED de punta a punta: resuelve el canal por phoneNumberId, valida el tenant, persiste el InboundEvent y llama a processGupshupMessage() con el tenantId correcto', async () => {
    const canalDedicado = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'DEDICATED',
      phoneNumber: '+51900000099',
      phoneNumberId: 'pnid-gateway-dedicado',
      providerAppId: 'gs-app-dedicado',
      providerAccountId: 'creaos' + business._id,
      status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado()]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    expect(webhookService.processGupshupMessage).toHaveBeenCalledWith(
      { phone: '51987654321', text: 'Hola, quiero info', name: 'Lead de prueba', mediaType: undefined, mediaSourceUrl: undefined },
      expect.anything()
    );
    const [, tenantIdPasado] = webhookService.processGupshupMessage.mock.calls[0];
    expect(String(tenantIdPasado)).toBe(String(business._id));

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-1' });
    expect(event).not.toBeNull();
    expect(String(event.channel)).toBe(String(canalDedicado._id));
    expect(String(event.tenantId)).toBe(String(business._id));
    expect(event.status).toBe('processed');
    expect(event.processedAt).toBeInstanceOf(Date);
  });

  test('mismo caso pero canal PLATFORM: resuelve y procesa exactamente igual (paridad, no hay rama especial por tipo de canal)', async () => {
    const canalPlatform = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'PLATFORM',
      phoneNumber: '+51901781253',
      phoneNumberId: 'pnid-gateway-dedicado',
      status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado()]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-1' });
    expect(String(event.channel)).toBe(String(canalPlatform._id));
    expect(event.status).toBe('processed');
  });

  test('ningún canal matchea el payload: se loguea warning, no se crea InboundEvent, no se llama a processGupshupMessage', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({ channelIdentifiers: { phoneNumberId: 'pnid-que-no-existe' } })]);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    expect(await InboundEvent.countDocuments({})).toBe(0);
    expect(webhookService.processGupshupMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[inboundGateway] ningún WhatsAppChannel matchea este payload',
      expect.objectContaining({ phoneNumberId: 'pnid-que-no-existe' })
    );

    warnSpy.mockRestore();
  });

  test('canal con tenant inválido (Business inactivo): tenantResolver rechaza, se loguea error, no se crea InboundEvent', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await Business.updateOne({ _id: business._id }, { isActive: false });
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'DEDICATED',
      phoneNumber: '+51900000098',
      phoneNumberId: 'pnid-gateway-tenant-invalido',
      status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({ channelIdentifiers: { phoneNumberId: 'pnid-gateway-tenant-invalido' } })]);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    expect(await InboundEvent.countDocuments({})).toBe(0);
    expect(webhookService.processGupshupMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[inboundGateway] tenant inválido, se descarta el mensaje',
      expect.objectContaining({ channelId: canal._id })
    );

    errorSpy.mockRestore();
  });

  test('mensaje duplicado (mismo providerMessageId, reentrega del proveedor): E11000, se ignora en silencio (info), no se re-procesa', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'DEDICATED',
      phoneNumber: '+51900000097',
      phoneNumberId: 'pnid-gateway-duplicado',
      status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({ channelIdentifiers: { phoneNumberId: 'pnid-gateway-duplicado' } })]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] }); // primera vez: se procesa
    expect(await InboundEvent.countDocuments({})).toBe(1);
    expect(webhookService.processGupshupMessage).toHaveBeenCalledTimes(1);

    await handle({ object: 'whatsapp_business_account', entry: [{}] }); // reentrega del mismo providerMessageId

    expect(await InboundEvent.countDocuments({})).toBe(1); // no se creó un segundo
    expect(webhookService.processGupshupMessage).toHaveBeenCalledTimes(1); // no se volvió a llamar
    expect(infoSpy).toHaveBeenCalledWith(
      '[inboundGateway] mensaje duplicado (idempotencia), se ignora',
      expect.objectContaining({ providerMessageId: 'msg-1' })
    );

    infoSpy.mockRestore();
  });

  test('processGupshupMessage() falla: el InboundEvent queda failed con el error, y el error se propaga (handleOne lo relanza)', async () => {
    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'DEDICATED',
      phoneNumber: '+51900000096',
      phoneNumberId: 'pnid-gateway-falla',
      status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({ channelIdentifiers: { phoneNumberId: 'pnid-gateway-falla' } })]);
    webhookService.processGupshupMessage.mockRejectedValue(new Error('OpenAI caído'));

    // handle() (a diferencia de handleOne()) nunca relanza — un mensaje del
    // batch no debe tumbar el resto (comportamiento ya documentado en el
    // propio archivo). Se prueba a través de handle(), no llamando a
    // handleOne() directo (no exportada), para cubrir el contrato real.
    await expect(handle({ object: 'whatsapp_business_account', entry: [{}] })).resolves.toBeUndefined();

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-1' });
    expect(event.status).toBe('failed');
    expect(event.error).toBe('OpenAI caído');
  });

  test('payload sin mensajes reconocibles: se loguea warning, nunca se llama a channelResolver/processGupshupMessage', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    mockNormalizeInboundEvent.mockReturnValue([]);

    await handle({ object: 'whatsapp_business_account', entry: [] });

    expect(webhookService.processGupshupMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[inboundGateway] payload sin mensajes de texto reconocibles', expect.anything());

    warnSpy.mockRestore();
  });

  test('2 mensajes en el mismo payload, el primero falla: el segundo se procesa igual (un mensaje del batch no tumba al resto)', async () => {
    await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000095', phoneNumberId: 'pnid-gateway-batch', status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([
      mensajeNormalizado({ providerMessageId: 'msg-batch-1', channelIdentifiers: { phoneNumberId: 'pnid-inexistente' } }), // no matchea -> no-op, no error
      mensajeNormalizado({ providerMessageId: 'msg-batch-2', channelIdentifiers: { phoneNumberId: 'pnid-gateway-batch' } }),
    ]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    expect(webhookService.processGupshupMessage).toHaveBeenCalledTimes(1);
    const event2 = await InboundEvent.findOne({ providerMessageId: 'msg-batch-2' });
    expect(event2.status).toBe('processed');
  });

  test('legacy (sin phoneNumberId/wabaId, solo appName): resuelve por providerAccountId igual que v3', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000094', phoneNumberId: 'pnid-gateway-legacy', providerAccountId: 'AppLegacyGateway', status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([
      mensajeNormalizado({ channelIdentifiers: { format: 'legacy', appName: 'AppLegacyGateway' } }),
    ]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'legacy', app: 'AppLegacyGateway' });

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-1' });
    expect(String(event.channel)).toBe(String(canal._id));
    expect(event.status).toBe('processed');
  });

  test('media entrante (imagen sin caption): mediaType/mediaSourceUrl se persisten en el InboundEvent y se pasan a processGupshupMessage', async () => {
    await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000093', phoneNumberId: 'pnid-gateway-media', status: 'active',
    });

    mockNormalizeInboundEvent.mockReturnValue([mensajeNormalizado({
      channelIdentifiers: { phoneNumberId: 'pnid-gateway-media' },
      text: '',
      mediaType: 'image',
      mediaSourceUrl: 'https://filemanager.gupshup.io/x/foto.jpg',
    })]);
    webhookService.processGupshupMessage.mockResolvedValue(undefined);

    await handle({ object: 'whatsapp_business_account', entry: [{}] });

    const event = await InboundEvent.findOne({ providerMessageId: 'msg-1' });
    expect(event.mediaType).toBe('image');
    expect(event.mediaSourceUrl).toBe('https://filemanager.gupshup.io/x/foto.jpg');
    expect(webhookService.processGupshupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 'image', mediaSourceUrl: 'https://filemanager.gupshup.io/x/foto.jpg' }),
      expect.anything()
    );
  });
});
