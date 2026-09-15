jest.mock('../channels/channel.service');

const channelService = require('../channels/channel.service');
const { getStatus } = require('./whatsapp.controller');
const router = require('./whatsapp.routes');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('whatsapp.controller — endpoints activos', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no monta los endpoints legacy de conexiones simuladas', () => {
    const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
    expect(paths).not.toContain('/connections');
    expect(paths).not.toContain('/connections/:id');
  });

  test('status sin canal real activo devuelve connected:false', async () => {
    channelService.getChannelForTenant.mockResolvedValue(null);
    const res = mockRes();
    await getStatus({ businessId: 'tenant-a' }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ connected: false }) }));
  });
});
