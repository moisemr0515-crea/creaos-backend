// actualizarNegocio(): un nombre o una moneda vacíos NO tumban ni borran el resto del bloque de identidad.
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model');
const { actualizarNegocio } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_service_moneda';

describe('business.service#actualizarNegocio() — moneda y vacíos', () => {
  let negocio;
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await Business.deleteMany({}); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Business.deleteMany({});
    negocio = await Business.create({ name: 'Negocio de prueba', country: 'PE' });
  });

  test('un negocio nuevo nace en PEN (país PE) y se guarda así en la base', async () => {
    expect((await Business.findById(negocio._id).lean()).currency).toBe('PEN');
  });

  test('currency:"" y name:"" conservan su valor y el resto del bloque SÍ se guarda', async () => {
    const r = await actualizarNegocio(negocio._id, {
      name: '', currency: '', agentName: 'Marina', averageTicket: 150, aiInstructions: 'Sé amable',
    });
    expect(r.name).toBe('Negocio de prueba');
    expect(r.currency).toBe('PEN');
    expect(r.agentName).toBe('Marina');
    expect(r.averageTicket).toBe(150);
    expect(r.aiInstructions).toBe('Sé amable');
  });

  test('currency y name con solo espacios también se ignoran', async () => {
    const r = await actualizarNegocio(negocio._id, { name: '   ', currency: '  ', agentName: 'Alex' });
    expect(r.name).toBe('Negocio de prueba');
    expect(r.currency).toBe('PEN');
    expect(r.agentName).toBe('Alex');
  });

  test('una moneda real se guarda (ida y vuelta con la base) y se normaliza a mayúsculas', async () => {
    await actualizarNegocio(negocio._id, { currency: 'mxn' });
    expect((await Business.findById(negocio._id).lean()).currency).toBe('MXN');
    await actualizarNegocio(negocio._id, { currency: 'COP' });
    expect((await Business.findById(negocio._id).lean()).currency).toBe('COP');
  });

  test('otros campos SÍ pueden limpiarse con "" (agentName); solo name y currency ignoran el vacío', async () => {
    await actualizarNegocio(negocio._id, { agentName: 'Marina' });
    const r = await actualizarNegocio(negocio._id, { agentName: '' });
    expect(r.agentName).toBe('');
  });

  test('no migra nada: un negocio ya guardado con MXN conserva MXN', async () => {
    const viejo = await Business.collection.insertOne({
      name: 'Viejo', slug: 'viejo-x', country: 'PE', currency: 'MXN', createdAt: new Date(), updatedAt: new Date(),
    });
    expect((await Business.findById(viejo.insertedId).lean()).currency).toBe('MXN');
  });
});
