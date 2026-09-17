// Test real (Jest, Mongo real) de la invalidación activa del cache de
// authenticate() en user.service.js — diagnóstico de lentitud percibida
// (17/sep/2026, docs/post-hardening-diagnostico/). Mismo patrón que
// userScope.service.test.js (Mongo real, propia base de datos). Solo se
// mockea authCache.js, para poder verificar CUÁNDO se invalida sin
// necesitar Redis real.
jest.mock('../../middleware/authCache', () => ({ invalidarUsuarioCacheado: jest.fn() }));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const User = require('./user.model');
const Role = require('../roles/role.model');
const { invalidarUsuarioCacheado } = require('../../middleware/authCache');
const { actualizarUsuario, desactivarUsuario } = require('./user.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_user_service_authcache';

describe('user.service — invalidación activa del cache de usuario', () => {
  let business;
  let roleSales;
  let roleAdmin;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    roleSales = await Role.create({ name: 'Ventas', slug: `sales-${new mongoose.Types.ObjectId()}`, permissions: [] });
    roleAdmin = await Role.create({ name: 'Admin', slug: `admin-${new mongoose.Types.ObjectId()}`, permissions: [] });
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Business.deleteMany({});
    await Role.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await User.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const createUser = (overrides = {}) => User.create({
    business: business._id,
    role: roleSales._id,
    name: 'Vendedor',
    email: `${new mongoose.Types.ObjectId()}@invalidacion.test`,
    password: 'password-de-prueba',
    isActive: true,
    ...overrides,
  });

  describe('actualizarUsuario()', () => {
    test('cambiar isActive: invalida el cache del usuario', async () => {
      const user = await createUser();

      await actualizarUsuario(user._id.toString(), business._id.toString(), 'admin', { isActive: false });

      expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(user._id.toString());
    });

    test('cambiar roleId: invalida el cache del usuario', async () => {
      const user = await createUser();

      await actualizarUsuario(user._id.toString(), business._id.toString(), 'admin', { roleId: roleAdmin._id.toString() });

      expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(user._id.toString());
    });

    test('cambiar solo name/phone (sin isActive ni roleId): NO invalida — evita un DEL de Redis en cada edición de perfil trivial', async () => {
      const user = await createUser();

      await actualizarUsuario(user._id.toString(), business._id.toString(), 'admin', { name: 'Nuevo Nombre' });

      expect(invalidarUsuarioCacheado).not.toHaveBeenCalled();
    });
  });

  describe('desactivarUsuario()', () => {
    test('siempre invalida el cache del usuario desactivado', async () => {
      const user = await createUser();
      const solicitante = await createUser();

      await desactivarUsuario(user._id.toString(), business._id.toString(), solicitante._id.toString());

      expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(user._id.toString());
    });
  });
});
