jest.mock('../channels/channel.service');
jest.mock('./whatsapp.metrics.service');

const channelService = require('../channels/channel.service');
const { obtenerMetricasDeWhatsapp } = require('./whatsapp.metrics.service');
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

  describe('status — métricas reales de la tarjeta', () => {
    const canal = { _id: 'channel-a', createdAt: new Date('2026-10-15T14:30:00Z') };
    const metricas = { connectedAt: '2026-10-15T14:30:00.000Z', leadsReceived: 7, lastActivityAt: '2026-10-16T08:15:00.000Z' };
    const usuario = (slug, permissions) => ({ role: { slug, permissions } });

    beforeEach(() => {
      channelService.getChannelForTenant.mockResolvedValue(canal);
      channelService.getChannelStatus.mockResolvedValue({ connected: true, provider: 'gupshup', phoneNumber: '+51999999999', channelId: 'channel-a', status: 'active' });
      obtenerMetricasDeWhatsapp.mockResolvedValue(metricas);
    });

    const llamar = async (user) => {
      const res = mockRes();
      await getStatus({ businessId: 'tenant-a', user }, res, jest.fn());
      return res;
    };

    test('mezcla el estado del canal con las métricas y las pide SOLO para el negocio del token', async () => {
      const res = await llamar(usuario('owner', ['leads:read']));
      expect(obtenerMetricasDeWhatsapp).toHaveBeenCalledWith('tenant-a', canal, { negocioCompleto: true });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: { connected: true, provider: 'gupshup', phoneNumber: '+51999999999', channelId: 'channel-a', status: 'active', ...metricas },
      }));
    });

    test('Ventas (leads:own) NO recibe el total del negocio', async () => {
      await llamar(usuario('sales', ['leads:read', 'leads:own']));
      expect(obtenerMetricasDeWhatsapp).toHaveBeenCalledWith('tenant-a', canal, { negocioCompleto: false });
    });

    test('superadmin con leads:own sigue viendo el negocio completo (misma regla que Leads)', async () => {
      await llamar(usuario('superadmin', ['leads:read', 'leads:own']));
      expect(obtenerMetricasDeWhatsapp).toHaveBeenCalledWith('tenant-a', canal, { negocioCompleto: true });
    });

    test('sin usuario en la petición se trata como restringido (lo más seguro)', async () => {
      await llamar(undefined);
      expect(obtenerMetricasDeWhatsapp).toHaveBeenCalledWith('tenant-a', canal, { negocioCompleto: false });
    });

    test('sin canal activo no consulta métricas y todo queda en null', async () => {
      channelService.getChannelForTenant.mockResolvedValue(null);
      const res = await llamar(usuario('owner', ['leads:read']));
      expect(obtenerMetricasDeWhatsapp).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: { connected: false, provider: 'gupshup', phoneNumber: null, connectedAt: null, leadsReceived: null, lastActivityAt: null },
      }));
    });

    test('la ruta sigue pidiendo leads:read (el permiso no se amplió)', () => {
      const capa = router.stack.find((l) => l.route?.path === '/status');
      expect(capa).toBeDefined();
      expect(capa.route.methods.get).toBe(true);
    });
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
    channelService.getTemplateCatalog.mockResolvedValue({ templates: [{ name: 'seguimiento_comercial', variablesRequired: 3 }], catalogStatus: 'approved' });
    channelService.resolveTemplateVariables.mockReturnValue([{ index: 1, value: 'Lead A' }]);
    const res = mockRes();

    await getTemplates({ businessId: 'tenant-a', query: { conversationId: 'conversation-a' } }, res, jest.fn());

    expect(channelService.getChannelForConversation).toHaveBeenCalledWith(conversation, 'tenant-a');
    expect(channelService.getTemplateCatalog).toHaveBeenCalledWith('channel-a', 'tenant-a');
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
    channelService.getTemplateCatalog.mockResolvedValue({ templates: [], catalogStatus: 'pending' });
    const res = mockRes();

    await getTemplates({ businessId: 'tenant-a', query: { conversationId: 'conversation-a' } }, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { templates: [], catalogStatus: 'pending' },
    }));
    expect(channelService.getChannelForTenant).not.toHaveBeenCalled();
  });});
