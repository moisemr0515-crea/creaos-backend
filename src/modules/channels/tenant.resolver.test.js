// Test real (Jest, commiteado) de tenant.resolver.js — PR-08 del blueprint
// maestro (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md), agregado
// al confirmar que ni este archivo ni inbound.gateway.js tenían NINGÚN test
// (investigación de "¿el camino de entrada ya funciona con canales
// DEDICATED?" — la lógica ya era genérica sin cambios, solo faltaba
// cobertura). Contra Mongo real, en una base propia de este archivo.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const { resolve, assertTenantScope } = require('./tenant.resolver');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_tenant_resolver';

describe('tenantResolver#resolve()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('tenant activo: devuelve el tenantId validado', async () => {
    const tenantId = await resolve({ tenantId: business._id });
    expect(String(tenantId)).toBe(String(business._id));
  });

  // Caso central de PR-08: connectionType del channel es completamente
  // irrelevante para este resolver — solo mira tenantId. Se documenta
  // explícito con un channel-like DEDICATED para dejar constancia de que
  // no hace falta ninguna rama nueva acá.
  test('funciona igual sin importar el connectionType del channel (DEDICATED no es un caso especial)', async () => {
    const channelDedicadoFalso = { tenantId: business._id, connectionType: 'DEDICATED' };
    const tenantId = await resolve(channelDedicadoFalso);
    expect(String(tenantId)).toBe(String(business._id));
  });

  test('tenant inexistente: AppError 403', async () => {
    const tenantIdInexistente = new mongoose.Types.ObjectId();
    await expect(resolve({ tenantId: tenantIdInexistente })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('tenant inactivo (isActive:false): AppError 403 — mismo tratamiento que inexistente', async () => {
    await Business.updateOne({ _id: business._id }, { isActive: false });
    await expect(resolve({ tenantId: business._id })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('tenantResolver#assertTenantScope()', () => {
  test('IDs iguales (ObjectId vs ObjectId): no tira', () => {
    const id = new mongoose.Types.ObjectId();
    expect(() => assertTenantScope(id, id)).not.toThrow();
  });

  test('IDs iguales en distinto tipo (ObjectId vs string): no tira — compara por String()', () => {
    const id = new mongoose.Types.ObjectId();
    expect(() => assertTenantScope(id, String(id))).not.toThrow();
    expect(() => assertTenantScope(String(id), id)).not.toThrow();
  });

  test('IDs distintos: AppError 500, mensaje explícito de bug de aislamiento', () => {
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();
    expect(() => assertTenantScope(id1, id2)).toThrow(expect.objectContaining({ statusCode: 500, message: expect.stringMatching(/aislamiento/i) }));
  });
});
