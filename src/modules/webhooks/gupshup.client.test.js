// Test real (Jest, commiteado) de gupshup.client.js — PR-07a del blueprint
// maestro (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §3/§5).
//
// Mockea global.fetch — nunca pega contra Gupshup real. Foco: las funciones
// de ENVÍO (sendWhatsAppMessage/sendTemplateMessage/sendMediaMessage/
// downloadMedia) usan los parámetros que reciben (apiKey/source/appName),
// NO las env vars globales de config/env.js — para probarlo de verdad, las
// env vars se setean a un valor "trampa" (GUPSHUP_*_GLOBAL_NO_USAR) distinto
// del que se pasa por parámetro, y se asevera que el request que sale usa
// el valor del PARÁMETRO, no el de la env var.
process.env.GUPSHUP_API_KEY = 'apikey-global-no-usar';
process.env.GUPSHUP_APP_NAME = 'app-global-no-usar';
process.env.GUPSHUP_PHONE_NUMBER = '10000000000';
process.env.GUPSHUP_WABA_ID = 'waba-global-no-usar';

const {
  sendWhatsAppMessage,
  sendTemplateMessage,
  sendMediaMessage,
  downloadMedia,
  estaConfigurado,
} = require('./gupshup.client');

describe('gupshup.client — funciones de envío (PR-07a: credenciales por parámetro, no por env var global)', () => {
  const originalFetch = global.fetch;
  const CREDENCIALES_DEL_TENANT = { apiKey: 'apikey-real-del-tenant', source: '51900000001', appName: 'creaos507f1f77bcf86cd799439011' };

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

  describe('sendWhatsAppMessage()', () => {
    test('usa apiKey/source/appName del PARÁMETRO, no las env vars globales', async () => {
      global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted', messageId: 'msg-1' }));

      await sendWhatsAppMessage('51987654321', 'hola', CREDENCIALES_DEL_TENANT);

      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.gupshup.io/wa/api/v1/msg');
      expect(init.headers.apikey).toBe('apikey-real-del-tenant');
      expect(init.headers.apikey).not.toBe('apikey-global-no-usar');

      const body = new URLSearchParams(init.body);
      expect(body.get('source')).toBe('51900000001');
      expect(body.get('src.name')).toBe('creaos507f1f77bcf86cd799439011');
      expect(body.get('destination')).toBe('51987654321');
      expect(body.get('message')).toBe(JSON.stringify({ type: 'text', text: 'hola' }));
    });

    test('respuesta ok: devuelve el JSON crudo de Gupshup', async () => {
      global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted', messageId: 'msg-1' }));
      const result = await sendWhatsAppMessage('51987654321', 'hola', CREDENCIALES_DEL_TENANT);
      expect(result).toEqual({ status: 'submitted', messageId: 'msg-1' });
    });

    test('respuesta no-ok: tira con el status y el body de error', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'Invalid API Key' });
      await expect(sendWhatsAppMessage('51987654321', 'hola', CREDENCIALES_DEL_TENANT)).rejects.toThrow(/401/);
    });
  });

  describe('sendTemplateMessage()', () => {
    test('usa apiKey/source/appName del parámetro, arma el template en el body', async () => {
      global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted' }));

      await sendTemplateMessage('51987654321', { id: 'tpl-1', params: ['Ana'] }, CREDENCIALES_DEL_TENANT);

      const [, init] = global.fetch.mock.calls[0];
      expect(init.headers.apikey).toBe('apikey-real-del-tenant');
      const body = new URLSearchParams(init.body);
      expect(body.get('source')).toBe('51900000001');
      expect(body.get('src.name')).toBe('creaos507f1f77bcf86cd799439011');
      expect(body.get('template')).toBe(JSON.stringify({ id: 'tpl-1', params: ['Ana'] }));
    });
  });

  describe('sendMediaMessage()', () => {
    test('imagen: usa apiKey/source/appName del parámetro, shape originalUrl/previewUrl', async () => {
      global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted' }));

      await sendMediaMessage('51987654321', { url: 'https://x.com/foto.jpg', type: 'image', caption: 'hola' }, CREDENCIALES_DEL_TENANT);

      const [, init] = global.fetch.mock.calls[0];
      expect(init.headers.apikey).toBe('apikey-real-del-tenant');
      const body = new URLSearchParams(init.body);
      expect(body.get('source')).toBe('51900000001');
      expect(body.get('src.name')).toBe('creaos507f1f77bcf86cd799439011');
      expect(JSON.parse(body.get('message'))).toEqual({
        type: 'image', originalUrl: 'https://x.com/foto.jpg', previewUrl: 'https://x.com/foto.jpg', caption: 'hola',
      });
    });

    test('video: usa apiKey/source/appName del parámetro, shape url', async () => {
      global.fetch.mockResolvedValue(mockJsonResponse({ status: 'submitted' }));

      await sendMediaMessage('51987654321', { url: 'https://x.com/video.mp4', type: 'video' }, CREDENCIALES_DEL_TENANT);

      const [, init] = global.fetch.mock.calls[0];
      const body = new URLSearchParams(init.body);
      expect(JSON.parse(body.get('message'))).toEqual({ type: 'video', url: 'https://x.com/video.mp4' });
    });
  });

  describe('downloadMedia()', () => {
    test('usa el apiKey del PARÁMETRO, no la env var global', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        arrayBuffer: async () => Buffer.from('contenido-binario'),
        headers: { get: () => 'image/jpeg' },
      });

      await downloadMedia('https://filemanager.gupshup.io/x/y.jpg', { apiKey: 'apikey-real-del-tenant' });

      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://filemanager.gupshup.io/x/y.jpg');
      expect(init.headers.apikey).toBe('apikey-real-del-tenant');
      expect(init.headers.apikey).not.toBe('apikey-global-no-usar');
    });

    test('devuelve buffer + contentType', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        arrayBuffer: async () => Buffer.from('contenido-binario'),
        headers: { get: () => 'image/jpeg' },
      });

      const result = await downloadMedia('https://filemanager.gupshup.io/x/y.jpg', { apiKey: 'x' });
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.contentType).toBe('image/jpeg');
    });
  });

  describe('estaConfigurado() — NO cambia en PR-07a, sigue leyendo env vars globales (canal PLATFORM)', () => {
    test('true si GUPSHUP_API_KEY/GUPSHUP_PHONE_NUMBER/GUPSHUP_WABA_ID están todas configuradas', () => {
      expect(estaConfigurado()).toBe(true);
    });
  });
});
