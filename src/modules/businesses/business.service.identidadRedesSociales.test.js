// Test real (Jest, Mongo real) — "Identidad del negocio": website ya
// existía en el schema y en el allowlist de actualizarNegocio()
// (commit cec7abc); facebookUrl/instagramUrl/tiktokUrl se agregan en este
// PR de cero (schema + validación de formato + allowlist del endpoint).
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model'); // actualizarNegocio() hace populate('createdBy', ...)
const { actualizarNegocio } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_identidad_redes';

describe('Business.model — validación de formato de facebookUrl/instagramUrl/tiktokUrl', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  afterEach(async () => {
    await Business.deleteMany({});
  });

  test('acepta URLs http(s) bien formadas para las 3 redes, sin exigir el dominio exacto de cada una', async () => {
    const business = await Business.create({
      name: 'Negocio de prueba',
      facebookUrl: 'https://facebook.com/creaos',
      instagramUrl: 'https://instagram.com/creaos',
      tiktokUrl: 'https://tiktok.com/@creaos',
    });
    expect(business.facebookUrl).toBe('https://facebook.com/creaos');
    expect(business.instagramUrl).toBe('https://instagram.com/creaos');
    expect(business.tiktokUrl).toBe('https://tiktok.com/@creaos');
  });

  test('acepta que un negocio use dominio propio para su página (no exige que sea *.facebook.com literal)', async () => {
    const business = await Business.create({
      name: 'Negocio de prueba',
      facebookUrl: 'https://mi-linktree.com/mi-negocio',
    });
    expect(business.facebookUrl).toBe('https://mi-linktree.com/mi-negocio');
  });

  test('rechaza un valor que no es una URL bien formada', async () => {
    await expect(
      Business.create({ name: 'Negocio de prueba', instagramUrl: 'no-es-una-url' })
    ).rejects.toThrow(/instagramUrl debe ser una URL válida/);
  });

  test('rechaza un valor sin protocolo http(s) (ej. solo el handle)', async () => {
    await expect(
      Business.create({ name: 'Negocio de prueba', tiktokUrl: '@creaos' })
    ).rejects.toThrow(/tiktokUrl debe ser una URL válida/);
  });

  test('los 3 campos son opcionales — un negocio sin ninguno se crea sin error', async () => {
    const business = await Business.create({ name: 'Negocio de prueba' });
    expect(business.facebookUrl).toBeNull();
    expect(business.instagramUrl).toBeNull();
    expect(business.tiktokUrl).toBeNull();
  });
});

describe('business.service#actualizarNegocio() — website (ya existente) y redes sociales (nuevas)', () => {
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

  test('persiste los 4 campos juntos (website + facebookUrl + instagramUrl + tiktokUrl) en la misma llamada, mismo endpoint que el resto de Identidad del negocio', async () => {
    const actualizado = await actualizarNegocio(business._id, {
      website: 'https://creaemprendedores.com',
      facebookUrl: 'https://facebook.com/creaos',
      instagramUrl: 'https://instagram.com/creaos',
      tiktokUrl: 'https://tiktok.com/@creaos',
    });

    expect(actualizado.website).toBe('https://creaemprendedores.com');
    expect(actualizado.facebookUrl).toBe('https://facebook.com/creaos');
    expect(actualizado.instagramUrl).toBe('https://instagram.com/creaos');
    expect(actualizado.tiktokUrl).toBe('https://tiktok.com/@creaos');

    // Releído aparte — no confiar solo en lo que devuelve la propia llamada.
    const releido = await Business.findById(business._id);
    expect(releido.facebookUrl).toBe('https://facebook.com/creaos');
  });

  test('actualizar solo 1 de las 3 redes no descarta ni pisa las otras 2 ya guardadas', async () => {
    await actualizarNegocio(business._id, {
      facebookUrl: 'https://facebook.com/creaos',
      instagramUrl: 'https://instagram.com/creaos',
    });

    const actualizado = await actualizarNegocio(business._id, {
      tiktokUrl: 'https://tiktok.com/@creaos',
    });

    expect(actualizado.facebookUrl).toBe('https://facebook.com/creaos');
    expect(actualizado.instagramUrl).toBe('https://instagram.com/creaos');
    expect(actualizado.tiktokUrl).toBe('https://tiktok.com/@creaos');
  });
});
