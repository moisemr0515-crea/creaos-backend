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
// PR1 (docs/implementation/known-issues.md, 07/sep/2026): cliente Partner,
// mockeado entero — mismo criterio que gupshup.client.js de arriba.
jest.mock('../../webhooks/gupshup.partner.client');
// Allowlist fija para todo el archivo — un solo appId "habilitado" alcanza
// para probar ambas ramas (dentro/fuera de la lista) sin necesitar mocks
// dinámicos de env por test.
jest.mock('../../../config/env', () => ({
  GUPSHUP_PARTNER_OUTBOUND_APP_IDS: ['app-en-allowlist'],
}));

const channelCredentialsService = require('../channelCredentials.service');
const gupshupClient = require('../../webhooks/gupshup.client');
const gupshupPartnerClient = require('../../webhooks/gupshup.partner.client');
const GupshupProvider = require('./gupshupProvider');

describe('GupshupProvider', () => {
  let provider;

  // Canal DEDICATED de ejemplo — mismo shape que crea
  // channelOnboardingCompletion.service.js (PR-06/07a): providerAccountId
  // real (no null), distinto del PLATFORM. Sin providerAppId a propósito —
  // representa el estado ANTERIOR a la migración a Partner API (PR #81-83),
  // sigue siendo un caso real y válido: debe seguir yendo por Legacy.
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

  // PR1 — fixtures nuevos para el routing Legacy/Partner por allowlist.
  const channelDedicadoFueraDeAllowlist = {
    _id: 'channel-fuera-allowlist-id',
    connectionType: 'DEDICATED',
    phoneNumber: '51900000002',
    providerAccountId: 'creaos-otro-tenant',
    providerAppId: 'app-fuera-de-allowlist', // tiene providerAppId, pero NO está en GUPSHUP_PARTNER_OUTBOUND_APP_IDS
  };

  const channelDedicadoEnAllowlist = {
    _id: 'channel-en-allowlist-id',
    connectionType: 'DEDICATED',
    phoneNumber: '51967424911',
    providerAccountId: 'creaos6a9b96597ed1485fda9fade3',
    providerAppId: 'app-en-allowlist',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new GupshupProvider();
  });

  // PR1: usaPartnerAPI() es el único criterio de routing — se testea
  // directo (función pura, expuesta como GupshupProvider.usaPartnerAPI)
  // antes de probar el "cableado" completo en sendMessage() más abajo.
  describe('GupshupProvider.usaPartnerAPI()', () => {
    test('PLATFORM sin providerAppId: false (Legacy)', () => {
      expect(GupshupProvider.usaPartnerAPI(channelPlatform)).toBe(false);
    });

    test('PLATFORM con providerAppId por error (no debería pasar nunca): igual false — exclusión explícita por connectionType, no solo por ausencia de appId', () => {
      const platformConAppIdPorError = { ...channelPlatform, providerAppId: 'app-en-allowlist' };
      expect(GupshupProvider.usaPartnerAPI(platformConAppIdPorError)).toBe(false);
    });

    test('DEDICATED sin providerAppId (estado pre-Partner API): false (Legacy)', () => {
      expect(GupshupProvider.usaPartnerAPI(channelDedicado)).toBe(false);
    });

    test('DEDICATED con providerAppId FUERA del allowlist: false (Legacy) — rollout no llegó a este canal todavía', () => {
      expect(GupshupProvider.usaPartnerAPI(channelDedicadoFueraDeAllowlist)).toBe(false);
    });

    test('DEDICATED con providerAppId DENTRO del allowlist: true (Partner)', () => {
      expect(GupshupProvider.usaPartnerAPI(channelDedicadoEnAllowlist)).toBe(true);
    });

    // CAMBIO 3 del diseño: un canal sin providerAppId NUNCA puede quedar
    // "habilitado" para Partner — es una exclusión estructural de
    // usaPartnerAPI(), no algo que dependa de un chequeo de error aparte
    // más adelante. providerAppId vacío ('') se trata igual que ausente.
    test('DEDICATED con providerAppId vacío (string vacío): false — nunca queda "habilitado" por accidente', () => {
      const canalConAppIdVacio = { ...channelDedicadoEnAllowlist, providerAppId: '' };
      expect(GupshupProvider.usaPartnerAPI(canalConAppIdVacio)).toBe(false);
    });
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

    // PR1 (docs/implementation/known-issues.md, 07/sep/2026) — routing
    // Legacy/Partner. La IA (webhook.service.js#processGupshupMessage()) y
    // el envío manual (ai.service.js#sendAgentMessage()) llegan ACÁ por el
    // MISMO camino sin cambios (channelService.sendMessage()), así que
    // probar el routing acá cubre ambos casos de uso reales sin necesitar
    // tocar esos 2 archivos ni sus tests.
    describe('routing Partner API (PR1)', () => {
      test('canal PLATFORM: sigue por Legacy, NUNCA llama a gupshupPartnerClient', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-del-env-de-platform' });
        gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMessage(channelPlatform, '51987654321', 'hola');

        expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con providerAppId FUERA del allowlist: sigue por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-real' });
        gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMessage(channelDedicadoFueraDeAllowlist, '51987654321', 'hola');

        expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con providerAppId DENTRO del allowlist: usa Partner con appId+Authorization correctos, NUNCA llama a Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        gupshupPartnerClient.sendTextMessage.mockResolvedValue({ messages: [{ id: 'msg-real-1' }] });

        const result = await provider.sendMessage(channelDedicadoEnAllowlist, '51923523382', 'Prueba CREA OS');

        expect(gupshupPartnerClient.sendTextMessage).toHaveBeenCalledWith('51923523382', 'Prueba CREA OS', {
          apiKey: 'partner-app-access-token-real',
          source: '51967424911',
          appName: 'creaos6a9b96597ed1485fda9fade3',
          appId: 'app-en-allowlist',
        });
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(result).toEqual({ messages: [{ id: 'msg-real-1' }] });
      });

      // CAMBIO 3 del diseño: un canal YA DECIDIDO para Partner (su appId
      // está en el allowlist) que falla resolviendo credenciales (ej. sin
      // ChannelCredentials) propaga el error tal cual — jamás reintenta
      // silenciosamente por Legacy con una configuración incompleta.
      test('canal en el allowlist SIN ChannelCredentials: el error se propaga, NUNCA cae a Legacy', async () => {
        const errorSinCredenciales = Object.assign(
          new Error('Canal channel-en-allowlist-id sin ChannelCredentials — ¿onboarding incompleto?'),
          { statusCode: 500 }
        );
        channelCredentialsService.resolveCredentials.mockRejectedValue(errorSinCredenciales);

        await expect(provider.sendMessage(channelDedicadoEnAllowlist, '51923523382', 'hola')).rejects.toBe(errorSinCredenciales);
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      // Mismo criterio, un paso más adelante: si Gupshup Partner API en sí
      // responde error (401/400 reales, ver known-issues.md), tampoco se
      // reintenta por Legacy — se propaga tal cual, igual que ya hace
      // Legacy hoy (ai.service.js#sendAgentMessage() ya lo captura sin
      // relanzar, marca whatsappStatus:'failed', sin cambios ahí).
      test('canal en el allowlist, Partner API responde error real: se propaga, NUNCA reintenta por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        const errorPartner = new Error('Gupshup Partner API error: 401 {"message":"Authentication Failed","status":"error"}');
        gupshupPartnerClient.sendTextMessage.mockRejectedValue(errorPartner);

        await expect(provider.sendMessage(channelDedicadoEnAllowlist, '51923523382', 'hola')).rejects.toBe(errorPartner);
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
      });
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
