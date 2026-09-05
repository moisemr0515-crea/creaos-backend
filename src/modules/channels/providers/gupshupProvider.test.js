// Test real (Jest, commiteado) de gupshupProvider.js — PR-07a del blueprint
// maestro (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §3/§5).
// Este archivo no tenía ningún test hasta este PR.
//
// channelCredentials.service.js y gupshup.client.js se mockean enteros —
// este archivo prueba SOLO el "cableado": que GupshupProvider resuelve
// credenciales por el channel correcto y se las pasa a gupshup.client.js tal
// cual, y que un rechazo de resolveCredentials() (canal huérfano, PR-06) se
// propaga sin ser atrapado acá (fail-loud, el fail-soft vive una capa arriba).
jest.mock('../channelCredentials.service');
jest.mock('../../webhooks/gupshup.client');

const channelCredentialsService = require('../channelCredentials.service');
const gupshupClient = require('../../webhooks/gupshup.client');
const GupshupProvider = require('./gupshupProvider');

describe('GupshupProvider', () => {
  let provider;

  // Canal DEDICATED de ejemplo — mismo shape que crea
  // channelOnboardingCompletion.service.js (PR-06/07a): providerAccountId
  // real (no null), distinto del PLATFORM.
  const channelDedicado = {
    _id: 'channel-dedicado-id',
    connectionType: 'DEDICATED',
    phoneNumber: '51900000001',
    providerAccountId: 'creaos507f1f77bcf86cd799439011',
  };

  const channelPlatform = {
    _id: 'channel-platform-id',
    connectionType: 'PLATFORM',
    phoneNumber: '51900000000',
    providerAccountId: 'CREAOS',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new GupshupProvider();
  });

  describe('sendMessage()', () => {
    test('resuelve credenciales del channel correcto y se las pasa a gupshup.client.js junto con phoneNumber/providerAccountId', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-real-del-tenant' });
      gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

      const result = await provider.sendMessage(channelDedicado, '51987654321', 'hola');

      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelDedicado);
      expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalledWith('51987654321', 'hola', {
        apiKey: 'apikey-real-del-tenant',
        source: '51900000001',
        appName: 'creaos507f1f77bcf86cd799439011',
      });
      expect(result).toEqual({ status: 'submitted' });
    });

    test('canal PLATFORM: mismo camino, credenciales resueltas por resolveCredentials() igual que DEDICATED', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-del-env-de-platform' });
      gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

      await provider.sendMessage(channelPlatform, '51987654321', 'hola');

      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelPlatform);
      expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalledWith('51987654321', 'hola', {
        apiKey: 'apikey-del-env-de-platform',
        source: '51900000000',
        appName: 'CREAOS',
      });
    });

    test('resolveCredentials() rechaza (canal DEDICATED huérfano, sin ChannelCredentials): el error se propaga, NUNCA se llama a gupshup.client.js', async () => {
      const errorHuerfano = Object.assign(new Error('Canal channel-dedicado-id sin ChannelCredentials — ¿onboarding incompleto?'), { statusCode: 500 });
      channelCredentialsService.resolveCredentials.mockRejectedValue(errorHuerfano);

      await expect(provider.sendMessage(channelDedicado, '51987654321', 'hola')).rejects.toBe(errorHuerfano);
      expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendTemplate()', () => {
    test('resuelve credenciales y las pasa junto con el template', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-real-del-tenant' });
      gupshupClient.sendTemplateMessage.mockResolvedValue({ status: 'submitted' });

      const template = { id: 'tpl-1', params: ['Ana'] };
      await provider.sendTemplate(channelDedicado, '51987654321', template);

      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelDedicado);
      expect(gupshupClient.sendTemplateMessage).toHaveBeenCalledWith('51987654321', template, {
        apiKey: 'apikey-real-del-tenant',
        source: '51900000001',
        appName: 'creaos507f1f77bcf86cd799439011',
      });
    });

    test('resolveCredentials() rechaza: se propaga, no llama a gupshup.client.js', async () => {
      const error = new Error('sin credenciales');
      channelCredentialsService.resolveCredentials.mockRejectedValue(error);

      await expect(provider.sendTemplate(channelDedicado, '51987654321', { id: 'tpl-1' })).rejects.toBe(error);
      expect(gupshupClient.sendTemplateMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMedia()', () => {
    test('resuelve credenciales y las pasa junto con la media', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-real-del-tenant' });
      gupshupClient.sendMediaMessage.mockResolvedValue({ status: 'submitted' });

      const media = { url: 'https://x.com/foto.jpg', type: 'image' };
      await provider.sendMedia(channelDedicado, '51987654321', media);

      expect(gupshupClient.sendMediaMessage).toHaveBeenCalledWith('51987654321', media, {
        apiKey: 'apikey-real-del-tenant',
        source: '51900000001',
        appName: 'creaos507f1f77bcf86cd799439011',
      });
    });

    test('resolveCredentials() rechaza: se propaga, no llama a gupshup.client.js', async () => {
      const error = new Error('sin credenciales');
      channelCredentialsService.resolveCredentials.mockRejectedValue(error);

      await expect(provider.sendMedia(channelDedicado, '51987654321', { url: 'x', type: 'image' })).rejects.toBe(error);
      expect(gupshupClient.sendMediaMessage).not.toHaveBeenCalled();
    });
  });

  describe('downloadMedia()', () => {
    test('resuelve credenciales del channel correcto, pasa SOLO apiKey (no source/appName, gupshup.client.js#downloadMedia no los usa)', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-real-del-tenant' });
      gupshupClient.downloadMedia.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/jpeg' });

      const result = await provider.downloadMedia(channelDedicado, 'https://filemanager.gupshup.io/x/y.jpg');

      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelDedicado);
      expect(gupshupClient.downloadMedia).toHaveBeenCalledWith('https://filemanager.gupshup.io/x/y.jpg', { apiKey: 'apikey-real-del-tenant' });
      expect(result).toEqual({ buffer: Buffer.from('x'), contentType: 'image/jpeg' });
    });

    test('resolveCredentials() rechaza: se propaga, no llama a gupshup.client.js', async () => {
      const error = new Error('sin credenciales');
      channelCredentialsService.resolveCredentials.mockRejectedValue(error);

      await expect(provider.downloadMedia(channelDedicado, 'https://x.com/y.jpg')).rejects.toBe(error);
      expect(gupshupClient.downloadMedia).not.toHaveBeenCalled();
    });
  });

  // getChannelStatus() SÍ cambió acá (bug encontrado auditando Conexiones en
  // crea-os-ignite: devolvía GUPSHUP_PHONE_NUMBER, el número compartido de
  // PLATFORM, sin importar qué canal se le pasara — incluso un DEDICATED
  // real ya conectado). listTemplates() no tiene cambios, se deja aparte.
  describe('getChannelStatus()', () => {
    test('devuelve el phoneNumber/connectionType del canal DEDICATED real, no el compartido de plataforma', async () => {
      gupshupClient.estaConfigurado.mockReturnValue(true);

      const status = await provider.getChannelStatus(channelDedicado);

      expect(status).toEqual({
        connected: true,
        provider: 'gupshup',
        phoneNumber: channelDedicado.phoneNumber,
        connectionType: 'DEDICATED',
      });
      expect(channelCredentialsService.resolveCredentials).not.toHaveBeenCalled();
    });

    test('devuelve el phoneNumber/connectionType del canal PLATFORM cuando el canal resuelto es ese', async () => {
      gupshupClient.estaConfigurado.mockReturnValue(true);

      const status = await provider.getChannelStatus(channelPlatform);

      expect(status.phoneNumber).toBe(channelPlatform.phoneNumber);
      expect(status.connectionType).toBe('PLATFORM');
    });

    test('sin Gupshup configurado (estaConfigurado():false), phoneNumber/connectionType quedan null aunque el canal exista', async () => {
      gupshupClient.estaConfigurado.mockReturnValue(false);

      const status = await provider.getChannelStatus(channelDedicado);

      expect(status).toEqual({
        connected: false,
        provider: 'gupshup',
        phoneNumber: null,
        connectionType: null,
      });
    });
  });

  describe('listTemplates() — sin cambios en este fix', () => {
    test('sigue sin usar el channel ni resolveCredentials()', async () => {
      gupshupClient.listTemplates.mockResolvedValue([{ id: 'tpl-1' }]);

      const templates = await provider.listTemplates(channelDedicado);

      expect(templates).toEqual([{ id: 'tpl-1' }]);
      expect(channelCredentialsService.resolveCredentials).not.toHaveBeenCalled();
    });
  });
});
