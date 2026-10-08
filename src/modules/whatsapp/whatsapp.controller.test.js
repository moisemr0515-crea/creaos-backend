jest.mock('../channels/channel.service');

const channelService = require('../channels/channel.service');
const { getStatus, getTemplates } = require('./whatsapp.controller');
const Conversation = require('../ai/conversation.model');
const Business = require('../businesses/business.model');
const router = require('./whatsapp.routes');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('whatsapp.controller — endpoints activos', () => {
  beforeEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

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

  test('catálogo usa exclusivamente el canal original de la conversación y el tenant actual', async () => {
    const conversation = { _id: 'conversation-a', business: 'tenant-a', lead: { name: 'Lead A' } };
    jest.spyOn(Conversation, 'findOne').mockReturnValue({
      populate: jest.fn().mockResolvedValue(conversation),
    });
    jest.spyOn(Business, 'findById').mockReturnValue({
      select: jest.fn().mockResolvedValue({ name: 'Negocio A', agentName: 'Agente A' }),
    });
    channelService.getChannelForConversation.mockResolvedValue({ _id: 'channel-a' });
    channelService.listTemplates.mockResolvedValue([{ name: 'seguimiento_comercial', variablesRequired: 3 }]);
    channelService.resolveTemplateVariables.mockReturnValue([{ index: 1, value: 'Lead A' }]);
    const res = mockRes();

    await getTemplates({ businessId: 'tenant-a', query: { conversationId: 'conversation-a' } }, res, jest.fn());

    expect(channelService.getChannelForConversation).toHaveBeenCalledWith(conversation, 'tenant-a');
    expect(channelService.listTemplates).toHaveBeenCalledWith('channel-a', 'tenant-a');
    expect(channelService.getChannelForTenant).not.toHaveBeenCalled();
  });

  test('canal original sin templates devuelve catálogo vacío, sin fallback', async () => {
    const conversation = { _id: 'conversation-a', business: 'tenant-a', lead: { name: 'Lead A' } };
    jest.spyOn(Conversation, 'findOne').mockReturnValue({
      populate: jest.fn().mockResolvedValue(conversation),
    });
    jest.spyOn(Business, 'findById').mockReturnValue({
      select: jest.fn().mockResolvedValue({ name: 'Negocio A', agentName: 'Agente A' }),
    });
    channelService.getChannelForConversation.mockResolvedValue({ _id: 'channel-a' });
    channelService.listTemplates.mockResolvedValue([]);
    const res = mockRes();

    await getTemplates({ businessId: 'tenant-a', query: { conversationId: 'conversation-a' } }, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { templates: [] },
    }));
    expect(channelService.getChannelForTenant).not.toHaveBeenCalled();
  });});
