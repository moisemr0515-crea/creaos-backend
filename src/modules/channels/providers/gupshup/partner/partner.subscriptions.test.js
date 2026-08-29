// Test real (Jest, commiteado) de partner.subscriptions.js — PR-06 del
// blueprint maestro.
//
// Se preserva la clase real GupshupHttpError (para que `instanceof` siga
// funcionando dentro de partner.subscriptions.js) y solo se mockea
// `request` — nunca pega contra Gupshup real.
jest.mock('../gupshup.http.client', () => ({
  ...jest.requireActual('../gupshup.http.client'),
  request: jest.fn(),
}));

const httpClient = require('../gupshup.http.client');
const partnerSubscriptions = require('./partner.subscriptions');

const APIKEY = 'apikey-real-de-la-app';

function gupshupError(statusCode, body) {
  return new httpClient.GupshupHttpError(`Gupshup respondió ${statusCode}`, {
    status: statusCode >= 500 ? 'server_error' : 'client_error',
    statusCode,
    body,
    requestId: 'gsp_test',
  });
}

describe('partner.subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('subscribeToEvents()', () => {
    test('happy path: POST /wa/app/{appId}/subscription contra api.gupshup.io, header apikey (no token)', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success' }, requestId: 'gsp_x' });

      const result = await partnerSubscriptions.subscribeToEvents(
        'app-123',
        APIKEY,
        { url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'creaos-account-events', modes: ['ACCOUNT'] }
      );

      expect(result).toEqual({ status: 'success' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/wa/app/app-123/subscription',
          baseUrl: 'https://api.gupshup.io',
          headers: { apikey: APIKEY },
          form: { url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'creaos-account-events', version: 1, modes: '[ACCOUNT]', doCheck: true },
          idempotent: false,
        })
      );
    });

    test('varios modos: se serializan juntos entre corchetes', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'x', modes: ['ACCOUNT', 'MESSAGE'],
      });

      expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({ form: expect.objectContaining({ modes: '[ACCOUNT,MESSAGE]' }) }));
    });

    test('version/doCheck explícitos pisan los defaults', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: {}, requestId: 'gsp_x' });

      await partnerSubscriptions.subscribeToEvents('app-123', APIKEY, {
        url: 'https://backend.creaos.com/api/v1/webhooks/gupshup', tag: 'x', modes: ['ACCOUNT'], version: 2, doCheck: false,
      });

      expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({ form: expect.objectContaining({ version: 2, doCheck: false }) }));
    });

    test('sin url: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { tag: 'x', modes: ['ACCOUNT'] })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('sin tag: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', modes: ['ACCOUNT'] })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('modes vacío o ausente: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: [] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x' })).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('401 Authentication Failed: se mapea a AppError 401', async () => {
      httpClient.request.mockRejectedValue(gupshupError(401, { message: 'Authentication Failed' }));

      await expect(
        partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    test('500 de Gupshup: se mapea a AppError 502 (falla del proveedor)', async () => {
      httpClient.request.mockRejectedValue(gupshupError(500, { message: 'Internal Server Error' }));

      await expect(
        partnerSubscriptions.subscribeToEvents('app-123', APIKEY, { url: 'https://x.io/wh', tag: 'x', modes: ['ACCOUNT'] })
      ).rejects.toMatchObject({ statusCode: 502 });
    });
  });
});
