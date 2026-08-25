// Test real (Jest, commiteado) de channelCredentials.service.js#resolveCredentials()
// — Fase 2.0 del blueprint Meta+Gupshup Embedded Signup.
//
// CHANNEL_CREDENTIALS_KEY se setea ANTES de cualquier require de los
// módulos bajo prueba — config/env.js lo lee al cargar, y channelCrypto.js
// lo necesita para derivar subclaves.
process.env.CHANNEL_CREDENTIALS_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.GUPSHUP_API_KEY = 'sk_platform-test-key';

const mongoose = require('mongoose');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const Business = require('../businesses/business.model');
const { encrypt } = require('./channelCrypto');
const { resolveCredentials } = require('./channelCredentials.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_credentials';

describe('channelCredentials.service#resolveCredentials()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await ChannelCredentials.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ChannelCredentials.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('canal PLATFORM (connectionType:"PLATFORM") lee GUPSHUP_API_KEY, sin tocar Mongo ni cambiar de comportamiento', async () => {
    const canalPlatform = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'CREAOS',
      phoneNumber: '+51901781253',
      phoneNumberId: 'pnid-platform',
      status: 'active',
      connectionType: 'PLATFORM',
      // credentialsReference queda null a propósito — desde Fase 2.1 ya no es
      // el discriminador de esta rama (era el prefijo 'env:' como string
      // libre; ahora el campo es un ObjectId ref real hacia
      // ChannelCredentials, y ese string ya no es un valor válido). El
      // discriminador real es connectionType, ver channelCredentials.service.js.
    });

    const result = await resolveCredentials(canalPlatform);

    expect(result).toEqual({ appToken: null, apiKey: 'sk_platform-test-key' });
    // Confirma que ni siquiera se creó/consultó ChannelCredentials para este canal.
    const existentes = await ChannelCredentials.countDocuments({ channel: canalPlatform._id });
    expect(existentes).toBe(0);
  });

  test('canal PLATFORM con credentialsReference apuntando a un ChannelCredentials real: se ignora igual, connectionType manda', async () => {
    // credentialsReference es ahora solo informativo/de conveniencia (Fase
    // 2.1, blueprint §3) — nunca la fuente de verdad de esta rama. Un canal
    // PLATFORM con ese campo poblado (caso hipotético/de transición) tiene
    // que seguir yendo por env vars igual, no por ChannelCredentials.
    const canalPlatform = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'CREAOS-conCredsRef',
      phoneNumber: '+51901781254',
      phoneNumberId: 'pnid-platform-con-ref',
      status: 'active',
      connectionType: 'PLATFORM',
      credentialsReference: new mongoose.Types.ObjectId(),
    });

    const result = await resolveCredentials(canalPlatform);

    expect(result).toEqual({ appToken: null, apiKey: 'sk_platform-test-key' });
  });

  test('canal DEDICATED con credenciales válidas (appToken + apiKey) descifra correctamente', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantDedicado1',
      phoneNumber: '+51911111111',
      phoneNumberId: 'pnid-dedicated-1',
      status: 'active',
      connectionType: 'DEDICATED',
      credentialsReference: null, // se setea después de crear ChannelCredentials, en un PR posterior — acá alcanza con connectionType:'DEDICATED'
    });

    const appTokenPlano = 'sk_app-token-real-de-prueba';
    const apiKeyPlano = 'sk_api-key-real-de-prueba';

    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      appToken: { current: encrypt(appTokenPlano, String(canal._id)) },
      apiKeys: [{ value: encrypt(apiKeyPlano, String(canal._id)), label: 'primaria' }],
    });

    const result = await resolveCredentials(canal);

    expect(result).toEqual({ appToken: appTokenPlano, apiKey: apiKeyPlano });
  });

  test('canal DEDICATED sin appToken guardado (solo apiKey) devuelve appToken:null sin fallar', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantDedicado2',
      phoneNumber: '+51911111112',
      phoneNumberId: 'pnid-dedicated-2',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const apiKeyPlano = 'sk_solo-api-key';
    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [{ value: encrypt(apiKeyPlano, String(canal._id)) }],
    });

    const result = await resolveCredentials(canal);
    expect(result).toEqual({ appToken: null, apiKey: apiKeyPlano });
  });

  test('canal DEDICATED con varias apiKeys activas usa la más reciente, ignora las revocadas', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantDedicado3',
      phoneNumber: '+51911111113',
      phoneNumberId: 'pnid-dedicated-3',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [
        { value: encrypt('sk_vieja-revocada', String(canal._id)), revokedAt: new Date(), revokedReason: 'rotada' },
        { value: encrypt('sk_activa-mas-reciente', String(canal._id)) },
      ],
    });

    const result = await resolveCredentials(canal);
    expect(result.apiKey).toBe('sk_activa-mas-reciente');
  });

  test('elige por createdAt real, NO por orden del array — cubre el caso en que ambos divergen', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantOrdenDivergente',
      phoneNumber: '+51911111118',
      phoneNumberId: 'pnid-orden-divergente',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    // A propósito: la entrada verdaderamente más reciente (createdAt más
    // nuevo) va PRIMERA en el array, y la más vieja va última — el
    // opuesto del orden de inserción natural. Si resolveCredentials()
    // todavía confiara en la posición del array en vez de createdAt real,
    // esta prueba fallaría.
    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [
        { value: encrypt('sk_realmente-mas-nueva', String(canal._id)), createdAt: new Date('2026-01-02') },
        { value: encrypt('sk_realmente-mas-vieja', String(canal._id)), createdAt: new Date('2026-01-01') },
      ],
    });

    const result = await resolveCredentials(canal);
    expect(result.apiKey).toBe('sk_realmente-mas-nueva');
  });

  test('canal DEDICATED sin ChannelCredentials guardado: falla ruidoso (AppError), nunca devuelve null', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantSinCredenciales',
      phoneNumber: '+51911111114',
      phoneNumberId: 'pnid-sin-creds',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    await expect(resolveCredentials(canal)).rejects.toThrow(/sin ChannelCredentials/);
  });

  test('canal DEDICATED con todas las apiKeys revocadas: falla ruidoso, nunca devuelve null', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantTodoRevocado',
      phoneNumber: '+51911111115',
      phoneNumberId: 'pnid-todo-revocado',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [{ value: encrypt('sk_ya-no-sirve', String(canal._id)), revokedAt: new Date() }],
    });

    await expect(resolveCredentials(canal)).rejects.toThrow(/todas las apiKeys están revocadas/);
  });

  test('canal DEDICATED con dato cifrado corrupto: falla ruidoso (authTag no matchea), nunca devuelve null', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantCorrupto',
      phoneNumber: '+51911111116',
      phoneNumberId: 'pnid-corrupto',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const campoValido = encrypt('sk_original', String(canal._id));
    await ChannelCredentials.create({
      channel: canal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [{ value: { ...campoValido, ciphertext: Buffer.from('dato-corrupto-a-mano').toString('base64') } }],
    });

    await expect(resolveCredentials(canal)).rejects.toThrow(/credenciales ilegibles/);
  });

  test('canal DEDICATED con credenciales cifradas para OTRO canal (subclave equivocada): falla ruidoso', async () => {
    const canalReal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'TenantSubclaveEquivocada',
      phoneNumber: '+51911111117',
      phoneNumberId: 'pnid-subclave-equivocada',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    // Cifrado con la subclave de OTRO canal a propósito — simula, por
    // ejemplo, un bug de copy-paste entre documentos.
    const cifradoParaOtroCanal = encrypt('sk_pertenece-a-otro-canal', 'un-channelId-completamente-distinto');
    await ChannelCredentials.create({
      channel: canalReal._id,
      tenantId: business._id,
      provider: 'gupshup',
      apiKeys: [{ value: cifradoParaOtroCanal }],
    });

    await expect(resolveCredentials(canalReal)).rejects.toThrow(/credenciales ilegibles/);
  });
});
