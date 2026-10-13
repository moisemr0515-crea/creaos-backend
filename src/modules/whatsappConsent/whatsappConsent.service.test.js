const mongoose = require('mongoose');
const Lead = require('../leads/lead.model');
const WhatsAppConsent = require('./whatsappConsent.model');
const service = require('./whatsappConsent.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_whatsapp_consent_c003';

describe('C-003 — consentimiento y suppression WhatsApp', () => {
  const tenantA = new mongoose.Types.ObjectId();
  const tenantB = new mongoose.Types.ObjectId();
  let leadA;
  let leadB;

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    leadA = await Lead.create({ business: tenantA, name: 'Lead A', phone: '+51911111111' });
    leadB = await Lead.create({ business: tenantB, name: 'Lead B', phone: '+51911111111' });
  });

  test('un inbound voluntario crea opt-in conversacional con evidencia mínima', async () => {
    await service.recordInboundConsent({
      tenantId: tenantA,
      leadId: leadA._id,
      phone: '51911111111',
      text: 'Hola, necesito ayuda',
      providerMessageId: 'wamid-in-1',
    });
    const consent = await WhatsAppConsent.findOne({ tenantId: tenantA });
    expect(consent.status).toBe('OPTED_IN');
    expect(consent.purpose).toBe('conversational');
    expect(consent.grantedAt).toBeInstanceOf(Date);
    expect(consent.evidenceReference).toBe('provider-message:wamid-in-1');
  });

  test.each([
    'STOP', ' stop. ', 'BAJA', 'salir!!!', 'CANCELAR',
    'No me escribas', 'NO QUIERO MENSAJES.', 'No deseo recibir mensajes',
  ])('detecta baja aun con mayúsculas, espacios o puntuación: %s', (text) => {
    expect(service.isOptOutMessage(text)).toBe(true);
  });

  test('un opt-out conserva lead/inbound y activa suppression sin duplicar registro', async () => {
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'Hola', providerMessageId: 'in-1' });
    const result = await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: ' BAJA! ', providerMessageId: 'in-2' });
    expect(result.optedOut).toBe(true);
    expect(await Lead.findById(leadA._id)).not.toBeNull();
    expect(await WhatsAppConsent.countDocuments({ tenantId: tenantA, phone: leadA.phone })).toBe(1);
    const consent = await WhatsAppConsent.findOne({ tenantId: tenantA });
    expect(consent.status).toBe('OPTED_OUT');
    expect(consent.revokedAt).toBeInstanceOf(Date);
  });

  test('un inbound posterior a la baja no reactiva automáticamente', async () => {
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'STOP', providerMessageId: 'in-stop' });
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'Necesito soporte', providerMessageId: 'in-help' });
    expect((await WhatsAppConsent.findOne({ tenantId: tenantA })).status).toBe('OPTED_OUT');
  });

  test('bloquea comercial sin consentimiento y cuando está suprimido', async () => {
    expect(await service.canSendWhatsAppMessage({ tenantId: tenantA, phone: leadA.phone, messageIntent: 'marketing' }))
      .toEqual({ allowed: false, reason: 'whatsapp_consent_required' });
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'STOP', providerMessageId: 'in-stop' });
    expect(await service.canSendWhatsAppMessage({ tenantId: tenantA, phone: leadA.phone, messageIntent: 'automation' }))
      .toEqual({ allowed: false, reason: 'whatsapp_suppressed' });
  });

  test('inbound/reactivo y soporte permanecen permitidos con suppression', async () => {
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'STOP', providerMessageId: 'in-stop' });
    expect((await service.canSendWhatsAppMessage({ tenantId: tenantA, phone: leadA.phone, messageIntent: 'reactive' })).allowed).toBe(true);
    expect((await service.canSendWhatsAppMessage({ tenantId: tenantA, phone: leadA.phone, messageIntent: 'support' })).allowed).toBe(true);
  });

  test('re-opt-in exige confirmación, fuente autorizada y evidencia', async () => {
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'STOP', providerMessageId: 'in-stop' });
    await expect(service.registerExplicitOptIn({ tenantId: tenantA, leadId: leadA._id, source: 'manual_authorized', confirmation: true }))
      .rejects.toThrow(/evidencia/);
    await expect(service.registerExplicitOptIn({ tenantId: tenantA, leadId: leadA._id, source: 'unknown', evidenceReference: 'form-1', confirmation: true }))
      .rejects.toThrow(/Fuente/);
    const consent = await service.registerExplicitOptIn({
      tenantId: tenantA,
      leadId: leadA._id,
      source: 'manual_authorized',
      purpose: 'marketing',
      evidenceReference: 'formulario-2026-10-12',
      recordedBy: new mongoose.Types.ObjectId(),
      confirmation: true,
    });
    expect(consent.status).toBe('OPTED_IN');
    expect((await service.canSendWhatsAppMessage({ tenantId: tenantA, phone: leadA.phone, messageIntent: 'commercial' })).allowed).toBe(true);
  });

  test('tenant isolation: el mismo teléfono mantiene estados independientes', async () => {
    await service.recordInboundConsent({ tenantId: tenantA, leadId: leadA._id, phone: leadA.phone, text: 'STOP', providerMessageId: 'a-stop' });
    await service.registerExplicitOptIn({ tenantId: tenantB, leadId: leadB._id, source: 'web_form', purpose: 'marketing', evidenceReference: 'form-b', confirmation: true });
    expect((await service.getConsentForLead(tenantA, leadA._id)).status).toBe('OPTED_OUT');
    expect((await service.getConsentForLead(tenantB, leadB._id)).status).toBe('OPTED_IN');
  });

  test('no permite consultar o registrar consentimiento sobre un lead de otro tenant', async () => {
    await expect(service.getConsentForLead(tenantA, leadB._id)).rejects.toThrow(/Lead no encontrado/);
    await expect(service.registerExplicitOptIn({
      tenantId: tenantA,
      leadId: leadB._id,
      source: 'web_form',
      evidenceReference: 'form-x',
      confirmation: true,
    })).rejects.toThrow(/Lead no encontrado/);
  });

  test('la respuesta pública no expone teléfono, evidencia ni historial', async () => {
    await service.registerExplicitOptIn({ tenantId: tenantA, leadId: leadA._id, source: 'web_form', purpose: 'marketing', evidenceReference: 'private-ref', confirmation: true });
    const result = await service.getConsentForLead(tenantA, leadA._id);
    expect(result).toEqual(expect.objectContaining({ status: 'OPTED_IN', purpose: 'marketing' }));
    expect(result.phone).toBeUndefined();
    expect(result.evidenceReference).toBeUndefined();
    expect(result.history).toBeUndefined();
  });
});
