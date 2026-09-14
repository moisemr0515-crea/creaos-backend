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
// PR2: ya no hay allowlist acá — solo el kill switch de emergencia. Default
// apagado (false) para todo el archivo; el test específico del kill switch
// lo pisa con jest.resetModules()+jest.doMock() (ver ese describe).
jest.mock('../../../config/env', () => ({
  GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH: false,
}));

const channelCredentialsService = require('../channelCredentials.service');
const gupshupClient = require('../../webhooks/gupshup.client');
const gupshupPartnerClient = require('../../webhooks/gupshup.partner.client');
const GupshupProvider = require('./gupshupProvider');

describe('GupshupProvider', () => {
  let provider;

  // Canal DEDICATED de ejemplo — mismo shape que crea
  // channelOnboardingCompletion.service.js (PR-06/07a/PR2): providerAccountId
  // real (no null), distinto del PLATFORM. outboundApi:'legacy' explícito a
  // propósito — representa un canal DEDICATED que todavía no migró a
  // Partner (o uno creado antes de PR1/PR2), sigue siendo un caso real y
  // válido: debe seguir yendo por Legacy.
  const channelDedicado = {
    _id: 'channel-dedicado-id',
    connectionType: 'DEDICATED',
    outboundApi: 'legacy',
    phoneNumber: '51900000001',
    providerAccountId: 'creaos507f1f77bcf86cd799439011',
    status: 'active',
  };

  const channelPlatform = {
    _id: 'channel-platform-id',
    connectionType: 'PLATFORM',
    outboundApi: 'legacy',
    phoneNumber: '51900000000',
    providerAccountId: 'CREAOS',
    status: 'active',
  };

  // PR2 — canal DEDICATED correctamente provisionado y migrado a Partner:
  // outboundApi:'partner' explícito + providerAppId presente.
  const channelDedicadoPartner = {
    _id: 'channel-partner-id',
    connectionType: 'DEDICATED',
    outboundApi: 'partner',
    phoneNumber: '51967424911',
    providerAccountId: 'creaos6a9b96597ed1485fda9fade3',
    providerAppId: 'app-real-de-gupshup',
    status: 'active',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    channelCredentialsService.resolveCredentials.mockReset();
    channelCredentialsService.resolveCredentials.mockResolvedValue({ appToken: null, apiKey: 'apikey-default' });
    provider = new GupshupProvider();
  });

  // PR2: resolveOutboundMode() es el único criterio de routing — reemplaza
  // usaPartnerAPI()/el allowlist de PR1. Se testea directo (función pura,
  // expuesta como GupshupProvider.resolveOutboundMode) antes de probar el
  // "cableado" completo en sendMessage() más abajo.
  describe('GupshupProvider.resolveOutboundMode()', () => {
    test('PLATFORM (outboundApi:"legacy" explícito): "legacy"', () => {
      expect(GupshupProvider.resolveOutboundMode(channelPlatform)).toBe('legacy');
    });

    // Regla explícita del diseño: PLATFORM se excluye por connectionType,
    // NO solo por su propio outboundApi — defensa en profundidad ante una
    // edición manual errónea del campo.
    test('PLATFORM con outboundApi:"partner" por error (no debería pasar nunca): igual "legacy" — exclusión explícita por connectionType', () => {
      const platformConOutboundApiPorError = { ...channelPlatform, outboundApi: 'partner', providerAppId: 'app-real' };
      expect(GupshupProvider.resolveOutboundMode(platformConOutboundApiPorError)).toBe('legacy');
    });

    test('DEDICATED con outboundApi:"legacy" explícito: "legacy"', () => {
      expect(GupshupProvider.resolveOutboundMode(channelDedicado)).toBe('legacy');
    });

    // Documento viejo (pre-backfill de PR2) — .lean() no aplica defaults
    // de schema, así que outboundApi llega undefined en memoria.
    test('DEDICATED sin outboundApi en absoluto (documento viejo, sin backfill todavía): "legacy", sin error', () => {
      const canalSinCampo = { _id: 'x', connectionType: 'DEDICATED', phoneNumber: '51900000009', providerAccountId: 'creaos-x' };
      expect(GupshupProvider.resolveOutboundMode(canalSinCampo)).toBe('legacy');
    });

    test('DEDICATED con outboundApi:"partner" + providerAppId presente: "partner"', () => {
      expect(GupshupProvider.resolveOutboundMode(channelDedicadoPartner)).toBe('partner');
    });

    // Regla 6/7 del diseño: NUNCA fallback silencioso — configuración
    // inconsistente tira, no cae a Legacy.
    test('DEDICATED con outboundApi:"partner" pero SIN providerAppId: tira AppError controlado, NO cae a "legacy"', () => {
      const canalInconsistente = { ...channelDedicadoPartner, providerAppId: null };
      expect(() => GupshupProvider.resolveOutboundMode(canalInconsistente)).toThrow(
        /declarado outboundApi:'partner' pero sin providerAppId/
      );
    });

    test('DEDICATED con outboundApi:"partner" y providerAppId vacío (string vacío): mismo error controlado que ausente', () => {
      const canalInconsistente = { ...channelDedicadoPartner, providerAppId: '' };
      expect(() => GupshupProvider.resolveOutboundMode(canalInconsistente)).toThrow(
        /declarado outboundApi:'partner' pero sin providerAppId/
      );
    });

    // Kill switch — mecanismo de emergencia, NO el routing normal (regla 7
    // del diseño). Se fuerza vía jest.resetModules()/jest.doMock() porque
    // el resto del archivo necesita el mock con el switch en false.
    describe('kill switch de emergencia (GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH)', () => {
      // resetModules() tiene que correr ANTES de re-requerir el módulo (no
      // solo después) — si no, la primera vez que corre este describe,
      // require('./gupshupProvider') devuelve la instancia ya cacheada desde
      // el require de arriba del archivo (con KILL_SWITCH:false ya cerrado
      // por destructuring), y jest.doMock() no tiene ningún efecto real.
      beforeEach(() => {
        jest.resetModules();
      });

      afterEach(() => {
        jest.resetModules();
      });

      test('kill switch activo: fuerza "legacy" incluso para un canal outboundApi:"partner" válido y completo', () => {
        jest.doMock('../../../config/env', () => ({ GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH: true }));
        const GupshupProviderConKillSwitch = require('./gupshupProvider');

        expect(GupshupProviderConKillSwitch.resolveOutboundMode(channelDedicadoPartner)).toBe('legacy');
      });
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

    // PR2 (docs/implementation/known-issues.md, 07/sep/2026) — routing
    // Legacy/Partner por WhatsAppChannel.outboundApi. La IA
    // (webhook.service.js#processGupshupMessage()) y el envío manual
    // (ai.service.js#sendAgentMessage()) llegan ACÁ por el MISMO camino sin
    // cambios (channelService.sendMessage()), así que probar el routing acá
    // cubre ambos casos de uso reales sin necesitar tocar esos 2 archivos.
    describe('routing Partner/Legacy por outboundApi (PR2)', () => {
      test('canal PLATFORM: sigue por Legacy, NUNCA llama a gupshupPartnerClient', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-del-env-de-platform' });
        gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMessage(channelPlatform, '51987654321', 'hola');

        expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con outboundApi:"legacy" (no migrado todavía): sigue por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-real' });
        gupshupClient.sendWhatsAppMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMessage(channelDedicado, '51987654321', 'hola');

        expect(gupshupClient.sendWhatsAppMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con outboundApi:"partner" + providerAppId: usa Partner con appId+Authorization correctos, NUNCA llama a Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        gupshupPartnerClient.sendTextMessage.mockResolvedValue({ messages: [{ id: 'msg-real-1' }] });

        const result = await provider.sendMessage(channelDedicadoPartner, '51923523382', 'Prueba CREA OS');

        expect(gupshupPartnerClient.sendTextMessage).toHaveBeenCalledWith('51923523382', 'Prueba CREA OS', {
          apiKey: 'partner-app-access-token-real',
          source: '51967424911',
          appName: 'creaos6a9b96597ed1485fda9fade3',
          appId: 'app-real-de-gupshup',
        });
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(result).toEqual({ messages: [{ id: 'msg-real-1' }] });
      });

      // Regla 6/7 del diseño: un canal outboundApi:'partner' pero SIN
      // providerAppId (configuración inconsistente) tira ANTES de siquiera
      // resolver credenciales — nunca llama a ningún cliente de envío.
      test('canal outboundApi:"partner" SIN providerAppId: tira error controlado ANTES de resolver credenciales, ningún cliente se llama', async () => {
        const canalInconsistente = { ...channelDedicadoPartner, providerAppId: null };

        await expect(provider.sendMessage(canalInconsistente, '51923523382', 'hola')).rejects.toThrow(
          /declarado outboundApi:'partner' pero sin providerAppId/
        );
        expect(channelCredentialsService.resolveCredentials).not.toHaveBeenCalled();
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      // Canal correctamente marcado 'partner' que falla resolviendo
      // credenciales (ej. sin ChannelCredentials) — propaga el error tal
      // cual, jamás reintenta silenciosamente por Legacy.
      test('canal outboundApi:"partner" SIN ChannelCredentials: el error se propaga, NUNCA cae a Legacy', async () => {
        const errorSinCredenciales = Object.assign(
          new Error('Canal channel-partner-id sin ChannelCredentials — ¿onboarding incompleto?'),
          { statusCode: 500 }
        );
        channelCredentialsService.resolveCredentials.mockRejectedValue(errorSinCredenciales);

        await expect(provider.sendMessage(channelDedicadoPartner, '51923523382', 'hola')).rejects.toBe(errorSinCredenciales);
        expect(gupshupClient.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(gupshupPartnerClient.sendTextMessage).not.toHaveBeenCalled();
      });

      // Mismo criterio, un paso más adelante: si Gupshup Partner API en sí
      // responde error (401/400 reales, ver known-issues.md), tampoco se
      // reintenta por Legacy — se propaga tal cual, igual que ya hace
      // Legacy hoy (ai.service.js#sendAgentMessage() ya lo captura sin
      // relanzar, marca whatsappStatus:'failed', sin cambios ahí).
      test('canal outboundApi:"partner", Partner API responde error real: se propaga, NUNCA reintenta por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        const errorPartner = new Error('Gupshup Partner API error: 401 {"message":"Authentication Failed","status":"error"}');
        gupshupPartnerClient.sendTextMessage.mockRejectedValue(errorPartner);

        await expect(provider.sendMessage(channelDedicadoPartner, '51923523382', 'hola')).rejects.toBe(errorPartner);
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

    // Auditoría de factibilidad de send_media (12/sep/2026), Paso 1 —
    // hallazgo real: antes de este cambio, sendMedia() llamaba SIEMPRE a
    // gupshupClient (Legacy) sin mirar resolveOutboundMode(), aunque los 3
    // WhatsAppChannel activos en producción hoy están en
    // outboundApi:'partner'. Mismo patrón de tests que
    // sendMessage() > 'routing Partner/Legacy por outboundApi (PR2)'.
    describe('routing Partner/Legacy por outboundApi (Paso 1 send_media)', () => {
      test('canal PLATFORM: sigue por Legacy, NUNCA llama a gupshupPartnerClient', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-del-env-de-platform' });
        gupshupClient.sendMediaMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMedia(channelPlatform, '51987654321', { url: 'x', type: 'image' });

        expect(gupshupClient.sendMediaMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendMediaMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con outboundApi:"legacy" (no migrado todavía): sigue por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-real' });
        gupshupClient.sendMediaMessage.mockResolvedValue({ status: 'submitted' });

        await provider.sendMedia(channelDedicado, '51987654321', { url: 'x', type: 'video' });

        expect(gupshupClient.sendMediaMessage).toHaveBeenCalled();
        expect(gupshupPartnerClient.sendMediaMessage).not.toHaveBeenCalled();
      });

      test('canal DEDICATED con outboundApi:"partner" + providerAppId: usa Partner con appId+Authorization correctos, NUNCA llama a Legacy — caso real, los 3 canales activos hoy están así', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        gupshupPartnerClient.sendMediaMessage.mockResolvedValue({ messages: [{ id: 'msg-media-1' }] });
        const media = { url: 'https://cloudinary.test/logo.png', type: 'image' };

        const result = await provider.sendMedia(channelDedicadoPartner, '51923523382', media);

        expect(gupshupPartnerClient.sendMediaMessage).toHaveBeenCalledWith('51923523382', media, {
          apiKey: 'partner-app-access-token-real',
          source: '51967424911',
          appName: 'creaos6a9b96597ed1485fda9fade3',
          appId: 'app-real-de-gupshup',
        });
        expect(gupshupClient.sendMediaMessage).not.toHaveBeenCalled();
        expect(result).toEqual({ messages: [{ id: 'msg-media-1' }] });
      });

      test('canal outboundApi:"partner" + type:"document": SÍ funciona (a diferencia de Legacy, que no lo soporta)', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        gupshupPartnerClient.sendMediaMessage.mockResolvedValue({ messages: [{ id: 'msg-doc-1' }] });
        const media = { url: 'https://cloudinary.test/brochure.pdf', type: 'document', filename: 'brochure.pdf' };

        await provider.sendMedia(channelDedicadoPartner, '51923523382', media);

        expect(gupshupPartnerClient.sendMediaMessage).toHaveBeenCalledWith('51923523382', media, expect.any(Object));
      });

      test('canal outboundApi:"partner" SIN providerAppId: tira error controlado ANTES de resolver credenciales, ningún cliente se llama', async () => {
        const canalInconsistente = { ...channelDedicadoPartner, providerAppId: null };

        await expect(
          provider.sendMedia(canalInconsistente, '51923523382', { url: 'x', type: 'image' }),
        ).rejects.toThrow(/declarado outboundApi:'partner' pero sin providerAppId/);
        expect(channelCredentialsService.resolveCredentials).not.toHaveBeenCalled();
        expect(gupshupClient.sendMediaMessage).not.toHaveBeenCalled();
        expect(gupshupPartnerClient.sendMediaMessage).not.toHaveBeenCalled();
      });

      test('Partner API responde error real: se propaga, NUNCA reintenta por Legacy', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'partner-app-access-token-real' });
        const errorPartner = new Error('Gupshup Partner API error (media send): 400 {"message":"Media type not supported"}');
        gupshupPartnerClient.sendMediaMessage.mockRejectedValue(errorPartner);

        await expect(
          provider.sendMedia(channelDedicadoPartner, '51923523382', { url: 'x', type: 'image' }),
        ).rejects.toBe(errorPartner);
        expect(gupshupClient.sendMediaMessage).not.toHaveBeenCalled();
      });

      // Guard nuevo (Paso 1): document por Legacy caería en la rama "video"
      // de gupshup.client.js en silencio — se corta ANTES, con un error
      // identificable, en vez de mandar un request roto a Gupshup.
      test('canal Legacy + type:"document": falla explícito con 501, NUNCA llama a gupshup.client.js con un shape roto', async () => {
        channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-real' });

        await expect(
          provider.sendMedia(channelDedicado, '51987654321', { url: 'x', type: 'document', filename: 'brochure.pdf' }),
        ).rejects.toThrow(/Envío de documentos por WhatsApp no soportado todavía en el camino Legacy/);
        expect(gupshupClient.sendMediaMessage).not.toHaveBeenCalled();
        expect(gupshupPartnerClient.sendMediaMessage).not.toHaveBeenCalled();
      });
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
      const status = await provider.getChannelStatus(channelDedicado);

      expect(status).toEqual({
        connected: true,
        provider: 'gupshup',
        phoneNumber: channelDedicado.phoneNumber,
        connectionType: 'DEDICATED',
        channelId: channelDedicado._id,
        status: 'active',
      });
      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelDedicado);
    });

    test('devuelve el phoneNumber/connectionType del canal PLATFORM cuando el canal resuelto es ese', async () => {
      const status = await provider.getChannelStatus(channelPlatform);

      expect(status.phoneNumber).toBe(channelPlatform.phoneNumber);
      expect(status.connectionType).toBe('PLATFORM');
    });

    test('credenciales del canal no resolubles: falla cerrado en vez de usar configuración global', async () => {
      channelCredentialsService.resolveCredentials.mockRejectedValue(new Error('sin credenciales del canal'));
      await expect(provider.getChannelStatus(channelDedicado)).rejects.toThrow('sin credenciales del canal');
    });
  });

  describe('listTemplates() — credenciales por canal', () => {
    test('usa las credenciales y app del channel, no globals', async () => {
      channelCredentialsService.resolveCredentials.mockResolvedValue({ apiKey: 'apikey-tenant' });
      gupshupClient.listTemplates.mockResolvedValue([{ id: 'tpl-1' }]);

      const templates = await provider.listTemplates(channelDedicado);

      expect(templates).toEqual([{ id: 'tpl-1' }]);
      expect(channelCredentialsService.resolveCredentials).toHaveBeenCalledWith(channelDedicado);
      expect(gupshupClient.listTemplates).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'apikey-tenant', appName: channelDedicado.providerAccountId }));
    });
  });
});
