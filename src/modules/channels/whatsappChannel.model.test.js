// Test real (Jest, commiteado) de WhatsAppChannel — enfocado en el campo
// `outboundApi` agregado por PR2 (docs/implementation/known-issues.md,
// 07/sep/2026): fuente de verdad por canal de qué API de Gupshup usar para
// enviar (Legacy vs Partner). Ver gupshupProvider.js#resolveOutboundMode().
//
// Contra Mongo real (mismo criterio que el resto del repo para lógica
// basada en Mongoose) en una base de datos propia de este archivo — así no
// colisiona con otros archivos de test que también usen Mongo, sin importar
// el orden/paralelismo con el que Jest los corra.
const mongoose = require('mongoose');
const WhatsAppChannel = require('./whatsappChannel.model');
const Business = require('../businesses/business.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_whatsapp_channel_model';

describe('WhatsAppChannel (modelo) — outboundApi (PR2)', () => {
  let business;
  let contadorPhone = 0;

  // phoneNumber/phoneNumberId son únicos por índice compuesto (provider+phoneNumberId) —
  // cada test usa un número distinto para no chocar entre sí.
  function datosCanalBase() {
    contadorPhone += 1;
    return {
      tenantId: business._id,
      businessId: business._id,
      phoneNumber: `+5198765432${contadorPhone}`,
      phoneNumberId: `pnid-test-${contadorPhone}`,
      connectionType: 'DEDICATED',
    };
  }

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await WhatsAppChannel.init();
  });

  afterAll(async () => {
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await WhatsAppChannel.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('outboundApi default es "legacy" si no se especifica', async () => {
    const channel = await WhatsAppChannel.create(datosCanalBase());
    expect(channel.outboundApi).toBe('legacy');
  });

  test('acepta outboundApi:"legacy" explícito', async () => {
    const channel = await WhatsAppChannel.create({ ...datosCanalBase(), outboundApi: 'legacy' });
    expect(channel.outboundApi).toBe('legacy');
  });

  test('acepta outboundApi:"partner" explícito', async () => {
    const channel = await WhatsAppChannel.create({ ...datosCanalBase(), outboundApi: 'partner' });
    expect(channel.outboundApi).toBe('partner');
  });

  test('rechaza cualquier valor fuera del enum ("legacy"/"partner")', async () => {
    await expect(
      WhatsAppChannel.create({ ...datosCanalBase(), outboundApi: 'no_es_un_valor_valido' })
    ).rejects.toThrow(/no_es_un_valor_valido/);
  });

  test('OUTBOUND_APIS exporta exactamente ["legacy", "partner"]', () => {
    expect(WhatsAppChannel.OUTBOUND_APIS).toEqual(['legacy', 'partner']);
  });
});
