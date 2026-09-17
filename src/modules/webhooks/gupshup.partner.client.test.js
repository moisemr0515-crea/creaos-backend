// Test real (Jest, commiteado) de gupshup.partner.client.js — PR1 del
// diseño de migración de outbound (docs/implementation/known-issues.md,
// 07/sep/2026). Mismo patrón que gupshup.client.test.js: mockea
// global.fetch, nunca pega contra Gupshup real.
const { sendTextMessage, sendMediaMessage, listTemplates, sendTemplateMessage } = require('./gupshup.partner.client');

describe('gupshup.partner.client#sendTextMessage()', () => {
  const originalFetch = global.fetch;
  const CREDENCIALES = { apiKey: 'partner-app-access-token-real', appId: '4f81131f-3b56-4bf5-808f-4e05176d0315' };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }

  test('URL exacta: partner.gupshup.io/partner/app/{appId}/v3/message', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendTextMessage('51923523382', 'hola', CREDENCIALES);

    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://partner.gupshup.io/partner/app/4f81131f-3b56-4bf5-808f-4e05176d0315/v3/message');
  });

  test('usa el header Authorization con el Partner App Access Token — NUNCA "apikey"', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendTextMessage('51923523382', 'hola', CREDENCIALES);

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('partner-app-access-token-real');
    expect(init.headers.apikey).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Accept).toBe('application/json');
  });

  test('body es JSON válido con el shape v3 exacto (messaging_product/recipient_type/to/type/text.body)', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendTextMessage('51923523382', 'Prueba CREA OS', CREDENCIALES);

    const [, init] = global.fetch.mock.calls[0];
    expect(typeof init.body).toBe('string');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '51923523382',
      type: 'text',
      text: { body: 'Prueba CREA OS' },
    });
  });

  test('respuesta ok: devuelve el JSON crudo de Gupshup', async () => {
    const respuestaGupshup = { messages: [{ id: 'msg-real-1' }], messaging_product: 'whatsapp' };
    global.fetch.mockResolvedValue(mockJsonResponse(respuestaGupshup));

    const result = await sendTextMessage('51923523382', 'hola', CREDENCIALES);

    expect(result).toEqual(respuestaGupshup);
  });

  test('respuesta con error (400/401 de Gupshup): tira un Error con status+body, mismo formato que gupshup.client.js', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed', status: 'error' }, false, 401));

    await expect(sendTextMessage('51923523382', 'hola', CREDENCIALES)).rejects.toThrow(
      'Gupshup Partner API error: 401'
    );
  });

  test('nunca imprime la credencial — el texto del error no contiene el apiKey', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed' }, false, 401));

    try {
      await sendTextMessage('51923523382', 'hola', CREDENCIALES);
    } catch (err) {
      expect(err.message).not.toContain('partner-app-access-token-real');
    }
  });
});

// Auditoría de factibilidad de send_media (12/sep/2026) — Paso 1. Los 3
// shapes exactos se confirmaron contra la documentación OFICIAL de
// Gupshup Partner (no inventados): post_partner-app-appid-v3-image-message,
// post_partner-app-appid-v3-video-message y senddocumentmessage — mismo
// endpoint que sendTextMessage() ya usa, shape "estilo WhatsApp Cloud API"
// (NO el shape de gupshup.client.js Legacy, que usa originalUrl/previewUrl
// para imagen y form-urlencoded).
describe('gupshup.partner.client#sendMediaMessage()', () => {
  const originalFetch = global.fetch;
  const CREDENCIALES = { apiKey: 'partner-app-access-token-real', appId: '4f81131f-3b56-4bf5-808f-4e05176d0315' };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }

  test('mismo endpoint y mismo header Authorization que sendTextMessage()', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage('51923523382', { url: 'https://cloudinary.test/logo.png', type: 'image' }, CREDENCIALES);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://partner.gupshup.io/partner/app/4f81131f-3b56-4bf5-808f-4e05176d0315/v3/message');
    expect(init.headers.Authorization).toBe('partner-app-access-token-real');
    expect(init.headers.apikey).toBeUndefined();
  });

  test('image: shape exacto {type:"image", image:{link, caption}} — confirmado contra la doc de Gupshup', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage(
      '51923523382',
      { url: 'https://cloudinary.test/logo.png', type: 'image', caption: 'Nuestro logo' },
      CREDENCIALES,
    );

    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '51923523382',
      type: 'image',
      image: { link: 'https://cloudinary.test/logo.png', caption: 'Nuestro logo' },
    });
  });

  test('video: shape exacto {type:"video", video:{link, caption}} — confirmado contra la doc de Gupshup', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage(
      '51923523382',
      { url: 'https://cloudinary.test/presentacion.mp4', type: 'video' },
      CREDENCIALES,
    );

    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '51923523382',
      type: 'video',
      video: { link: 'https://cloudinary.test/presentacion.mp4' }, // sin caption, es opcional
    });
  });

  test('document: shape exacto {type:"document", document:{link, filename, caption}} — filename SÍ viaja cuando se provee', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage(
      '51923523382',
      {
        url: 'https://cloudinary.test/brochure.pdf',
        type: 'document',
        filename: 'brochure-creaos.pdf',
        caption: 'Nuestro brochure',
      },
      CREDENCIALES,
    );

    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '51923523382',
      type: 'document',
      document: {
        link: 'https://cloudinary.test/brochure.pdf',
        filename: 'brochure-creaos.pdf',
        caption: 'Nuestro brochure',
      },
    });
  });

  test('document sin filename: sigue funcionando, Gupshup lo trata como opcional (confirmado en su doc)', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage('51923523382', { url: 'https://cloudinary.test/brochure.pdf', type: 'document' }, CREDENCIALES);

    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.document).toEqual({ link: 'https://cloudinary.test/brochure.pdf' });
  });

  test('filename en un type que no es document: se ignora (Gupshup no lo espera ahí)', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ messages: [{ id: 'msg-1' }] }));

    await sendMediaMessage(
      '51923523382',
      { url: 'https://cloudinary.test/video.mp4', type: 'video', filename: 'no-deberia-viajar.mp4' },
      CREDENCIALES,
    );

    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.video).not.toHaveProperty('filename');
  });

  test('tipo no soportado: tira un Error claro ANTES de llamar a fetch (nunca gasta una petición a Gupshup con un shape roto)', async () => {
    await expect(
      sendMediaMessage('51923523382', { url: 'https://cloudinary.test/x.gif', type: 'gif' }, CREDENCIALES),
    ).rejects.toThrow(/tipo de media no soportado "gif"/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('respuesta con error de Gupshup: tira un Error con status+body, mismo formato que sendTextMessage()', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Media type not supported' }, false, 400));

    await expect(
      sendMediaMessage('51923523382', { url: 'https://cloudinary.test/x.png', type: 'image' }, CREDENCIALES),
    ).rejects.toThrow('Gupshup Partner API error (media send): 400');
  });

  test('respuesta ok: devuelve el JSON crudo de Gupshup', async () => {
    const respuestaGupshup = { messages: [{ id: 'msg-media-1' }], messaging_product: 'whatsapp' };
    global.fetch.mockResolvedValue(mockJsonResponse(respuestaGupshup));

    const result = await sendMediaMessage('51923523382', { url: 'https://cloudinary.test/x.png', type: 'image' }, CREDENCIALES);

    expect(result).toEqual(respuestaGupshup);
  });
});

// Bug real de producción (17/sep/2026, docs/post-hardening-diagnostico/ en
// creaos-backend): GET /api/v1/whatsapp/templates devolvía 500 SIEMPRE para
// los 3 WhatsAppChannel activos hoy (todos outboundApi:'partner') porque
// gupshupProvider.js#listTemplates() llamaba siempre al cliente Legacy, que
// rechaza credenciales Partner con 401 "Authentication Failed". Endpoint
// confirmado contra la documentación OFICIAL de Gupshup Partner (17/sep/2026):
// https://partner-docs.gupshup.io/reference/get_partner-app-appid-templates
describe('gupshup.partner.client#listTemplates()', () => {
  const originalFetch = global.fetch;
  const CREDENCIALES = { apiKey: 'partner-app-access-token-real', appId: '4f81131f-3b56-4bf5-808f-4e05176d0315' };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }

  test('URL exacta (GET) y header Authorization con el Partner App Access Token — NUNCA "apikey"', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'success', templates: [] }));

    await listTemplates(CREDENCIALES);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://partner.gupshup.io/partner/app/4f81131f-3b56-4bf5-808f-4e05176d0315/templates');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('partner-app-access-token-real');
    expect(init.headers.apikey).toBeUndefined();
  });

  test('respuesta ok: devuelve json.templates', async () => {
    const plantillas = [{ id: 'tpl-1', elementName: 'bienvenida', status: 'APPROVED' }];
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'success', templates: plantillas }));

    const result = await listTemplates(CREDENCIALES);

    expect(result).toEqual(plantillas);
  });

  test('respuesta sin campo templates: devuelve array vacío, no undefined', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'success' }));

    const result = await listTemplates(CREDENCIALES);

    expect(result).toEqual([]);
  });

  test('respuesta con error (401 de Gupshup): tira un Error con status+body, mismo formato que el resto del cliente', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed', status: 'error' }, false, 401));

    await expect(listTemplates(CREDENCIALES)).rejects.toThrow('Gupshup Partner API error (template list): 401');
  });

  test('nunca imprime la credencial — el texto del error no contiene el apiKey', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed' }, false, 401));

    try {
      await listTemplates(CREDENCIALES);
    } catch (err) {
      expect(err.message).not.toContain('partner-app-access-token-real');
    }
  });
});

// Send msg With Template ID — confirmado contra la documentación OFICIAL
// de Gupshup Partner (17/sep/2026):
// https://partner-docs.gupshup.io/reference/post_partner-app-appid-template-msg
// Mismo shape form-urlencoded que gupshup.client.js#sendTemplateMessage()
// (Legacy) — channel/source/destination/src.name/template son idénticos,
// solo cambian la base URL y el header de auth.
describe('gupshup.partner.client#sendTemplateMessage()', () => {
  const originalFetch = global.fetch;
  const CREDENCIALES = {
    apiKey: 'partner-app-access-token-real',
    appId: '4f81131f-3b56-4bf5-808f-4e05176d0315',
    source: '51900000001',
    appName: 'creaos507f1f77bcf86cd799439011',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }

  test('URL exacta (POST) y header Authorization — NUNCA "apikey"', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted', messageId: 'msg-tpl-1' }));

    await sendTemplateMessage('51923523382', { id: 'tpl-1', params: [] }, CREDENCIALES);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://partner.gupshup.io/partner/app/4f81131f-3b56-4bf5-808f-4e05176d0315/template/msg');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('partner-app-access-token-real');
    expect(init.headers.apikey).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  test('body form-urlencoded con el shape exacto: channel/source/destination/src.name/template', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted', messageId: 'msg-tpl-1' }));

    await sendTemplateMessage('51923523382', { id: 'tpl-1', params: ['Ana', 'lunes'] }, CREDENCIALES);

    const [, init] = global.fetch.mock.calls[0];
    const body = new URLSearchParams(init.body);
    expect(body.get('channel')).toBe('whatsapp');
    expect(body.get('source')).toBe('51900000001');
    expect(body.get('destination')).toBe('51923523382');
    expect(body.get('src.name')).toBe('creaos507f1f77bcf86cd799439011');
    expect(JSON.parse(body.get('template'))).toEqual({ id: 'tpl-1', params: ['Ana', 'lunes'] });
  });

  test('template sin params: manda params: [] (no undefined, no lo omite)', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted' }));

    await sendTemplateMessage('51923523382', { id: 'tpl-1' }, CREDENCIALES);

    const [, init] = global.fetch.mock.calls[0];
    const body = new URLSearchParams(init.body);
    expect(JSON.parse(body.get('template'))).toEqual({ id: 'tpl-1', params: [] });
  });

  test('respuesta ok: devuelve el JSON crudo de Gupshup', async () => {
    const respuestaGupshup = { status: 'submitted', messageId: 'msg-tpl-real-1' };
    global.fetch.mockResolvedValue(mockJsonResponse(respuestaGupshup));

    const result = await sendTemplateMessage('51923523382', { id: 'tpl-1' }, CREDENCIALES);

    expect(result).toEqual(respuestaGupshup);
  });

  test('respuesta con error (400/401 de Gupshup): tira un Error con status+body', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed' }, false, 401));

    await expect(sendTemplateMessage('51923523382', { id: 'tpl-1' }, CREDENCIALES)).rejects.toThrow(
      'Gupshup Partner API error (template send): 401'
    );
  });

  test('nunca imprime la credencial — el texto del error no contiene el apiKey', async () => {
    global.fetch.mockResolvedValue(mockJsonResponse({ message: 'Authentication Failed' }, false, 401));

    try {
      await sendTemplateMessage('51923523382', { id: 'tpl-1' }, CREDENCIALES);
    } catch (err) {
      expect(err.message).not.toContain('partner-app-access-token-real');
    }
  });
});
