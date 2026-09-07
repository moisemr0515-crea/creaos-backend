// Test real (Jest, commiteado) de gupshup.partner.client.js — PR1 del
// diseño de migración de outbound (docs/implementation/known-issues.md,
// 07/sep/2026). Mismo patrón que gupshup.client.test.js: mockea
// global.fetch, nunca pega contra Gupshup real.
const { sendTextMessage } = require('./gupshup.partner.client');

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
