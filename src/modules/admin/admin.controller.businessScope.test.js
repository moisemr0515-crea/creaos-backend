jest.mock('./dashboard.service');
jest.mock('../businesses/business.model');
jest.mock('../users/user.model');

const mongoose = require('mongoose');
const dashboardService = require('./dashboard.service');
const Business = require('../businesses/business.model');
const User = require('../users/user.model');
const { getBusinessDashboard, getActivityFeed } = require('./admin.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const ownBusinessId = new mongoose.Types.ObjectId().toString();
const otherBusinessId = new mongoose.Types.ObjectId().toString();

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const tenantRequest = (requestedId = ownBusinessId) => ({
  params: { businessId: requestedId },
  query: {},
  businessId: ownBusinessId,
  user: { business: ownBusinessId, role: { slug: 'admin' } },
});

describe('admin business scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Business.exists.mockResolvedValue({ _id: ownBusinessId });
    dashboardService.getBusinessStats.mockResolvedValue({ leads: 1 });
    dashboardService.getActivityFeed.mockResolvedValue([]);
  });

  test('tenant consulta su propio business: permitido y usa la membresía fresca', async () => {
    const req = tenantRequest();
    req.businessId = otherBusinessId; // JWT deliberadamente desactualizado
    const res = response();
    const next = jest.fn();

    await getBusinessDashboard(req, res, next);

    expect(dashboardService.getBusinessStats).toHaveBeenCalledWith(ownBusinessId);
    expect(next).not.toHaveBeenCalled();
  });

  test('tenant intenta consultar otro business: 403', async () => {
    const next = jest.fn();
    await getActivityFeed(tenantRequest(otherBusinessId), response(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(dashboardService.getActivityFeed).not.toHaveBeenCalled();
  });

  test('superadmin consulta otro business: permitido', async () => {
    Business.exists.mockResolvedValue({ _id: otherBusinessId });
    const req = {
      params: { businessId: otherBusinessId },
      query: {},
      user: { business: ownBusinessId, role: { slug: 'superadmin' } },
    };
    const next = jest.fn();

    await getBusinessDashboard(req, response(), next);

    expect(dashboardService.getBusinessStats).toHaveBeenCalledWith(otherBusinessId);
    expect(next).not.toHaveBeenCalled();
  });

  test('businessId válido pero inexistente: 404', async () => {
    Business.exists.mockResolvedValue(null);
    const next = jest.fn();

    await getBusinessDashboard(tenantRequest(), response(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(dashboardService.getBusinessStats).not.toHaveBeenCalled();
  });

  test('request sin autenticación: authenticate lo bloquea con 401', async () => {
    const next = jest.fn();
    await authenticate({ headers: {} }, response(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(User.findById).not.toHaveBeenCalled();
  });
});
