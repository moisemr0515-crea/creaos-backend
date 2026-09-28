const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Role = require('../roles/role.model');
const User = require('../users/user.model');

jest.mock('../../utils/email', () => ({
  enviarEmailVerificacion: jest.fn().mockResolvedValue(undefined),
  enviarEmailResetPassword: jest.fn().mockResolvedValue(undefined),
}));

const { registrar } = require('./auth.service');
const MONGO_URI = 'mongodb://localhost:27017/creaos_test_auth_standalone_compensation';

describe('auth.registrar fallback standalone', () => {
  let ownerRole;
  const payload = {
    name: 'Owner', email: 'owner@test.com', password: 'Password1', businessName: 'Nuevo negocio',
  };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    ownerRole = await Role.findOneAndUpdate(
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
    jest.restoreAllMocks();
    await User.deleteMany({});
    await Business.deleteMany({});
  });

  const forceStandalone = () => jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: jest.fn().mockRejectedValue(new Error('Transaction numbers are only allowed on a replica set member')),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  test('standalone success crea Business + User enlazados', async () => {
    forceStandalone();
    await expect(registrar(payload)).resolves.toMatchObject({ usuario: { email: payload.email } });
    const [business, user] = await Promise.all([Business.findOne({ name: payload.businessName }), User.findOne({ email: payload.email })]);
    expect(String(business.createdBy)).toBe(String(user._id));
    expect(String(user.business)).toBe(String(business._id));
  });

  test('si falla User.create compensa Business y preserva el error original', async () => {
    forceStandalone();
    jest.spyOn(User, 'create').mockRejectedValueOnce(new Error('user write failed'));
    await expect(registrar(payload)).rejects.toThrow('user write failed');
    expect(await User.countDocuments({})).toBe(0);
    expect(await Business.countDocuments({})).toBe(0);
  });

  test('si falla el enlace final compensa User + Business', async () => {
    forceStandalone();
    jest.spyOn(Business, 'findByIdAndUpdate').mockRejectedValueOnce(new Error('business link failed'));
    await expect(registrar(payload)).rejects.toThrow('business link failed');
    expect(await User.countDocuments({})).toBe(0);
    expect(await Business.countDocuments({})).toBe(0);
  });

  test('ruta transaccional conserva el comportamiento existente', async () => {
    const realSession = await mongoose.connection.startSession();
    jest.spyOn(realSession, 'withTransaction').mockImplementation(async (callback) => callback());
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(realSession);
    await expect(registrar(payload)).resolves.toMatchObject({ usuario: { email: payload.email } });
    expect(await Business.countDocuments({})).toBe(1);
    expect(await User.countDocuments({})).toBe(1);
  });
});
