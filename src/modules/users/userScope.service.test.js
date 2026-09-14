const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const User = require('./user.model');
const Role = require('../roles/role.model');
const { assertActiveUserInBusiness } = require('./userScope.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_user_scope';

describe('userScope.service — assignedTo multi-tenant', () => {
  let tenantA;
  let tenantB;
  let role;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    role = await Role.create({ name: 'Agente scope', slug: `scope-${new mongoose.Types.ObjectId()}`, permissions: [] });
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
    tenantA = await Business.create({ name: 'Tenant A' });
    tenantB = await Business.create({ name: 'Tenant B' });
  });

  const createUser = (business, overrides = {}) => User.create({
    business: business._id,
    role: role._id,
    name: 'Agente',
    email: `${new mongoose.Types.ObjectId()}@scope.test`,
    password: 'password-de-prueba',
    isActive: true,
    ...overrides,
  });

  test('assignedTo del mismo tenant y activo es permitido', async () => {
    const user = await createUser(tenantA);
    await expect(assertActiveUserInBusiness(user._id, tenantA._id)).resolves.toMatchObject({ _id: user._id });
  });

  test('assignedTo de otro tenant es rechazado', async () => {
    const user = await createUser(tenantB);
    await expect(assertActiveUserInBusiness(user._id, tenantA._id)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('assignedTo inactivo es rechazado', async () => {
    const user = await createUser(tenantA, { isActive: false });
    await expect(assertActiveUserInBusiness(user._id, tenantA._id)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('assignedTo ausente permanece opcional', async () => {
    await expect(assertActiveUserInBusiness(undefined, tenantA._id)).resolves.toBeNull();
  });
});
