// Test real (Jest, commiteado) de auth.service.js — normalización de email
// (testers reales vía Play Console, sep/2026). Antes de este fix,
// registrar()/login()/forgotPassword() usaban el email crudo de
// req.body — una variante de mayúsculas/espacios no matcheaba contra un
// usuario ya guardado (que Mongoose sí normaliza al escribir, via
// trim:true/lowercase:true en el schema — user.model.js), rompiendo la
// detección de duplicados en registrar() y el lookup de login()/
// forgotPassword().
//
// Alcance deliberadamente acotado: login()/registrar() completos (éxito)
// requieren Redis conectado (generarRefreshToken()) — no forma parte de
// este fix ni de este archivo. Cada test de acá llega hasta el punto
// exacto donde se puede confirmar que la normalización funcionó, sin
// necesitar que el resto del flujo (tokens) tenga éxito.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Role = require('../roles/role.model');
const User = require('../users/user.model');
const { hashPassword } = require('../../utils/crypto');

jest.mock('../../utils/email', () => ({
  enviarEmailVerificacion: jest.fn().mockResolvedValue(undefined),
  enviarEmailResetPassword: jest.fn().mockResolvedValue(undefined),
}));

const { registrar, login, forgotPassword } = require('./auth.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_auth_email_normalization';

describe('auth.service.js — normalización de email (variantes de mayúsculas/espacios)', () => {
  let business;
  let roleOwner;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    roleOwner = await Role.findOneAndUpdate(
      { slug: 'owner', business: null },
      { name: 'Owner', slug: 'owner', business: null, isSystem: true, permissions: [] },
      { upsert: true, new: true }
    );
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Business.deleteMany({});
    await Role.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('registrar(): una variante de mayúsculas/espacios de un email YA registrado se rechaza como duplicado (409), no crea un negocio/usuario nuevo', async () => {
    await User.create({
      business: business._id,
      name: 'Ya registrado',
      email: 'existente@test.com', // ya normalizado, como quedaría por el schema
      password: 'hash-de-prueba',
      role: roleOwner._id,
      isActive: true,
    });

    await expect(
      registrar({
        name: 'Intento duplicado',
        email: '  Existente@Test.com  ',
        password: 'Password1',
        businessName: 'Otro negocio',
      })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/ya está registrado/i) });

    // No se creó ningún Business/User nuevo — el rechazo fue ANTES de la transacción.
    expect(await Business.countDocuments({})).toBe(1); // solo el de beforeEach
    expect(await User.countDocuments({})).toBe(1); // solo el ya existente
  });

  test('forgotPassword(): encuentra al usuario con una variante de mayúsculas/espacios del email real y genera el token de reset sobre ESE usuario', async () => {
    const usuario = await User.create({
      business: business._id,
      name: 'Usuario real',
      email: 'usuario@test.com',
      password: await hashPassword('Password1'),
      role: roleOwner._id,
      isActive: true,
      isEmailVerified: true,
    });

    await forgotPassword({ email: '  Usuario@Test.com  ' });

    const actualizado = await User.findById(usuario._id).select('+passwordResetToken +passwordResetExpires');
    expect(actualizado.passwordResetToken).toEqual(expect.any(String));
    expect(actualizado.passwordResetExpires).toBeInstanceOf(Date);
  });

  test('login(): una variante de mayúsculas/espacios del email SÍ resuelve al usuario real (confirmado por el error específico de cuenta desactivada, no el genérico de "no encontrado")', async () => {
    await User.create({
      business: business._id,
      name: 'Usuario desactivado',
      email: 'desactivado@test.com',
      password: await hashPassword('Password1'),
      role: roleOwner._id,
      isActive: false, // desactivado a propósito: da un error DISTINTO y distinguible
      isEmailVerified: true,
    });

    // Si la normalización fallara, esto caería en "Credenciales inválidas"
    // (401, el mismo mensaje genérico que usa un email inexistente) — el
    // hecho de que dé específicamente el error de cuenta desactivada (403)
    // prueba que el lookup SÍ encontró al usuario real.
    await expect(
      login({ email: '  Desactivado@Test.com  ', password: 'Password1' })
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/desactivada/i) });
  });
});
