// Test real (Jest, Mongo real) de Business.model.js#esWhatsappValido —
// Frente 2 (diagnóstico multipaís, 19/sep/2026). El regex E.164 de
// whatsappNumber vivía SOLO en business.routes.js (express-validator) —
// cualquier escritura que no pasara por esa ruta puntual (ej. este mismo
// service llamado directo, como acá) no tenía ninguna validación de
// formato. Se movió al schema, mismo criterio que esUrlValida
// (facebookUrl/instagramUrl/tiktokUrl) — este test prueba actualizarNegocio()
// directo, SIN pasar por la ruta/express-validator, para confirmar que la
// protección real ahora vive en el modelo, no solo en el middleware HTTP.
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model');
const { actualizarNegocio } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_whatsapp_validation';

describe('Business.model — validación de whatsappNumber a nivel de schema', () => {
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

  test('un whatsappNumber mal formado se rechaza aunque no pase por la ruta HTTP (llamada directa al service)', async () => {
    await expect(actualizarNegocio(business._id, { whatsappNumber: 'abc' })).rejects.toMatchObject({
      name: 'ValidationError',
    });

    const releido = await Business.findById(business._id);
    expect(releido.whatsappNumber).toBeNull(); // nunca se escribió
  });

  test('Perú (+51...) real se acepta y persiste', async () => {
    const actualizado = await actualizarNegocio(business._id, { whatsappNumber: '+51987654321' });
    expect(actualizado.whatsappNumber).toBe('+51987654321');
  });

  test('Bolivia (+591...) real se acepta y persiste — no es un regex hardcodeado a Perú', async () => {
    const actualizado = await actualizarNegocio(business._id, { whatsappNumber: '+59171234567' });
    expect(actualizado.whatsappNumber).toBe('+59171234567');
  });

  test('Chile (+56...) real se acepta y persiste', async () => {
    const actualizado = await actualizarNegocio(business._id, { whatsappNumber: '+56912345678' });
    expect(actualizado.whatsappNumber).toBe('+56912345678');
  });

  test('Colombia (+57...) real se acepta y persiste', async () => {
    const actualizado = await actualizarNegocio(business._id, { whatsappNumber: '+573001234567' });
    expect(actualizado.whatsappNumber).toBe('+573001234567');
  });

  test('"" (negocio sin WhatsApp conectado) sigue siendo válido — no rompe el guardado del resto del formulario', async () => {
    const actualizado = await actualizarNegocio(business._id, { whatsappNumber: '', agentName: 'Marina' });
    expect(actualizado.whatsappNumber).toBe('');
    expect(actualizado.agentName).toBe('Marina');
  });

  test('un ValidationError de Mongoose lo traduce error.middleware.js a 400 (no 500) — verificación de contrato con el handler global', () => {
    const { errorHandler } = require('../../middleware/error.middleware');
    const err = new mongoose.Error.ValidationError();
    err.errors = { whatsappNumber: { message: 'whatsappNumber debe tener formato internacional válido (ej. +51987654321)' } };
    const req = { method: 'PUT', originalUrl: '/api/v1/businesses/current' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    errorHandler(err, req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'whatsappNumber debe tener formato internacional válido (ej. +51987654321)' })
    );
  });
});
