// Test real (Jest) de la invalidación activa del cache de
// authenticate()/injectTenant() en admin.controller.js — diagnóstico de
// lentitud percibida (17/sep/2026, docs/post-hardening-diagnostico/).
// Estas 5 rutas (suspendUser/activateUser/changeUserRole en Users,
// suspendBusiness/activateBusiness en Businesses) son una vía PARALELA
// a user.service.js#actualizarUsuario/desactivarUsuario para tocar los
// mismos campos (isActive/role) — si no invalidan acá también, una
// suspensión hecha por un Super Admin desde este panel quedaría sujeta
// al TTL de 8s en vez de reflejarse al instante. Mismo patrón mockeado
// que admin.controller.businessScope.test.js.
jest.mock('../businesses/business.model');
jest.mock('../users/user.model');
jest.mock('../roles/role.model');
jest.mock('../../middleware/authCache', () => ({
  invalidarUsuarioCacheado: jest.fn(),
  invalidarNegocioCacheado: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const User = require('../users/user.model');
const Role = require('../roles/role.model');
const { invalidarUsuarioCacheado, invalidarNegocioCacheado } = require('../../middleware/authCache');
const {
  changeUserRole,
  suspendUser,
  activateUser,
  suspendBusiness,
  activateBusiness,
} = require('./admin.controller');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const businessId = new mongoose.Types.ObjectId().toString();
const targetId = new mongoose.Types.ObjectId().toString();
const callerId = new mongoose.Types.ObjectId().toString();

const baseReq = () => ({
  params: { id: targetId },
  body: {},
  businessId,
  user: { _id: callerId, role: { slug: 'admin' } },
});

describe('admin.controller — invalidación activa del cache (Users/Businesses)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('changeUserRole(): invalida el cache del usuario objetivo tras guardar el nuevo rol', async () => {
    const target = { _id: targetId, business: businessId, role: null, save: jest.fn().mockResolvedValue(undefined) };
    User.findById.mockResolvedValue(target);
    Role.findOne.mockResolvedValue({ _id: 'role-nuevo' });
    const req = { ...baseReq(), body: { roleSlug: 'sales' } };

    await changeUserRole(req, response(), jest.fn());

    expect(target.save).toHaveBeenCalled();
    expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(targetId);
  });

  test('suspendUser(): invalida el cache del usuario suspendido', async () => {
    User.findById.mockResolvedValue({ _id: targetId, business: businessId });
    User.findByIdAndUpdate.mockResolvedValue({ _id: targetId, isActive: false });
    const req = baseReq();

    await suspendUser(req, response(), jest.fn());

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(targetId, { isActive: false });
    expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(targetId);
  });

  test('activateUser(): invalida el cache del usuario activado', async () => {
    User.findById.mockResolvedValue({ _id: targetId, business: businessId });
    User.findByIdAndUpdate.mockResolvedValue({ _id: targetId, isActive: true });
    const req = baseReq();

    await activateUser(req, response(), jest.fn());

    expect(invalidarUsuarioCacheado).toHaveBeenCalledWith(targetId);
  });

  test('suspendBusiness(): invalida el cache del negocio suspendido', async () => {
    Business.findByIdAndUpdate.mockResolvedValue({ _id: businessId, isActive: false });
    const req = { params: { id: businessId } };

    await suspendBusiness(req, response(), jest.fn());

    expect(invalidarNegocioCacheado).toHaveBeenCalledWith(businessId);
  });

  test('activateBusiness(): invalida el cache del negocio activado', async () => {
    Business.findByIdAndUpdate.mockResolvedValue({ _id: businessId, isActive: true });
    const req = { params: { id: businessId } };

    await activateBusiness(req, response(), jest.fn());

    expect(invalidarNegocioCacheado).toHaveBeenCalledWith(businessId);
  });

  test('suspendBusiness(): negocio inexistente — NO invalida nada (next() recibe el error)', async () => {
    Business.findByIdAndUpdate.mockResolvedValue(null);
    const next = jest.fn();

    await suspendBusiness({ params: { id: businessId } }, response(), next);

    expect(invalidarNegocioCacheado).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
