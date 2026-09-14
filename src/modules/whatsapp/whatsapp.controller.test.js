jest.mock('./whatsappConnection.model');
jest.mock('../channels/channel.service');

const WhatsAppConnection = require('./whatsappConnection.model');
const channelService = require('../channels/channel.service');
const { createConnection, listConnections, getStatus } = require('./whatsapp.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('whatsapp.controller — legacy y estado real', () => {
  beforeEach(() => jest.clearAllMocks());

  test('POST legacy no crea una conexión simulada y responde mediante AppError 410', async () => {
    const next = jest.fn();
    await createConnection({ body: { phoneNumber: '+51999999999' } }, mockRes(), next);
    expect(WhatsAppConnection.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 410 }));
  });

  test('GET legacy nunca representa un registro simulado histórico como operativo/connected', async () => {
    WhatsAppConnection.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([{ _id: 'legacy', status: 'connected', isSimulated: true }]) }) });
    const res = mockRes();
    await listConnections({ businessId: 'tenant-a' }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { connections: [expect.objectContaining({ status: 'legacy_simulated', operational: false })] } }));
  });

  test('status sin canal real activo devuelve connected:false', async () => {
    channelService.getChannelForTenant.mockResolvedValue(null);
    const res = mockRes();
    await getStatus({ businessId: 'tenant-a' }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ connected: false }) }));
  });
});
