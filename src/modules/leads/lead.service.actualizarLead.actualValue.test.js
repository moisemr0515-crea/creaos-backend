// Test real (Jest, commiteado) de lead.service.js#actualizarLead() — cableado
// del campo actualValue (monto real cobrado al cerrar una venta, distinto de
// potentialValue que es la estimación previa al cierre). Antes de este fix
// el campo no existía ni en el schema ni en updateLeadSchema — ver
// lead.model.js#actualValue y lead.validator.js#updateLeadSchema.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('./lead.model');
const { actualizarLead } = require('./lead.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_service_actualvalue';

describe('lead.service#actualizarLead() — actualValue', () => {
  let business;
  let lead;
  const actor = { _id: new mongoose.Types.ObjectId(), name: 'Actor de prueba' };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({
      business: business._id,
      name: 'Lead de prueba',
      potentialValue: 1000,
    });
  });

  test('un lead nuevo no tiene actualValue seteado (undefined, no 0)', async () => {
    const fresco = await Lead.findById(lead._id);
    expect(fresco.actualValue).toBeUndefined();
  });

  test('actualizarLead() persiste actualValue sin tocar potentialValue', async () => {
    const actualizado = await actualizarLead(business._id, lead._id, actor, { actualValue: 850 });
    expect(actualizado.actualValue).toBe(850);
    expect(actualizado.potentialValue).toBe(1000);

    const releido = await Lead.findById(lead._id);
    expect(releido.actualValue).toBe(850);
  });

  test('un valor negativo es rechazado (min:0 del schema)', async () => {
    await expect(actualizarLead(business._id, lead._id, actor, { actualValue: -50 })).rejects.toThrow();
    const releido = await Lead.findById(lead._id);
    expect(releido.actualValue).toBeUndefined();
  });

  test('no mandar actualValue no lo toca (queda con el valor que ya tenía)', async () => {
    await actualizarLead(business._id, lead._id, actor, { actualValue: 850 });
    await actualizarLead(business._id, lead._id, actor, { name: 'Nombre actualizado' });

    const releido = await Lead.findById(lead._id);
    expect(releido.actualValue).toBe(850);
    expect(releido.name).toBe('Nombre actualizado');
  });
});
