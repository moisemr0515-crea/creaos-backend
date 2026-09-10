// Test real (Jest, commiteado) de business.service.js#actualizarNegocio() —
// cableado del campo aiPersonality (toggle "Personalidad", crea-os-ignite,
// business.tsx). Antes de este fix, el campo no existía en el schema ni en
// el allowlist de camposPermitidos — el frontend lo mandaba por PUT
// /api/v1/users/me, que lo descartaba en silencio (ver
// user.controller.js#updateMiPerfil, solo persiste name/phone/avatar).
const mongoose = require('mongoose');
const Business = require('./business.model');
// actualizarNegocio() hace populate('createdBy', ...) — el schema de User
// tiene que estar registrado antes de esa llamada, aunque este archivo no
// lo use directamente.
require('../users/user.model');
const { actualizarNegocio } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_service_actualizarnegocio';

describe('business.service#actualizarNegocio() — aiPersonality', () => {
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

  test('default: un negocio nuevo sin aiPersonality seteado queda en "cercano"', async () => {
    const fresco = await Business.findById(business._id);
    expect(fresco.aiPersonality).toBe('cercano');
  });

  test('actualizarNegocio() persiste aiPersonality:"formal" — no se descarta', async () => {
    const actualizado = await actualizarNegocio(business._id, { aiPersonality: 'formal' });
    expect(actualizado.aiPersonality).toBe('formal');

    const releido = await Business.findById(business._id);
    expect(releido.aiPersonality).toBe('formal');
  });

  test('actualizarNegocio() persiste aiPersonality:"agresivo"', async () => {
    const actualizado = await actualizarNegocio(business._id, { aiPersonality: 'agresivo' });
    expect(actualizado.aiPersonality).toBe('agresivo');
  });

  test('un valor fuera del enum es rechazado por el schema (runValidators:true en actualizarNegocio())', async () => {
    await expect(actualizarNegocio(business._id, { aiPersonality: 'no-es-un-valor-valido' })).rejects.toThrow();

    // No se aplicó ningún cambio parcial — el documento queda intacto.
    const releido = await Business.findById(business._id);
    expect(releido.aiPersonality).toBe('cercano');
  });

  test('no mandar aiPersonality en absoluto no lo toca (queda con el valor que ya tenía)', async () => {
    await actualizarNegocio(business._id, { aiPersonality: 'formal' });
    await actualizarNegocio(business._id, { name: 'Nombre actualizado' }); // sin aiPersonality

    const releido = await Business.findById(business._id);
    expect(releido.aiPersonality).toBe('formal');
    expect(releido.name).toBe('Nombre actualizado');
  });
});
