// Test real (Jest, commiteado) de partner.apps.js — PR-02 del blueprint
// CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md.
//
// Se preserva la clase real GupshupHttpError (para que `instanceof` siga
// funcionando dentro de partner.apps.js) y solo se mockea `request` — nunca
// pega contra Gupshup real.
jest.mock('../gupshup.http.client', () => ({
  ...jest.requireActual('../gupshup.http.client'),
  request: jest.fn(),
}));

const httpClient = require('../gupshup.http.client');
const partnerApps = require('./partner.apps');

const TOKEN = 'jwt-de-prueba';

function gupshupError(statusCode, body) {
  return new httpClient.GupshupHttpError(`Gupshup Partner API respondió ${statusCode}`, {
    status: statusCode >= 500 ? 'server_error' : 'client_error',
    statusCode,
    body,
    requestId: 'gsp_test',
  });
}

describe('partner.apps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createApp()', () => {
    test('happy path: POST /partner/app con el header token, devuelve appId', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { appId: 'app-123' }, requestId: 'gsp_x' });

      const result = await partnerApps.createApp({ name: 'CREAOS-tenant-42' }, TOKEN);

      expect(result).toEqual({ appId: 'app-123' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/partner/app',
          headers: { token: TOKEN },
          form: { name: 'CREAOS-tenant-42' },
          idempotent: false,
        })
      );
    });

    test('incluye templateMessaging/disableOptinPrefUrl en el form solo si vienen', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { appId: 'app-123' }, requestId: 'gsp_x' });

      await partnerApps.createApp({ name: 'CREAOS-tenant-42', templateMessaging: true, disableOptinPrefUrl: false }, TOKEN);

      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ form: { name: 'CREAOS-tenant-42', templateMessaging: true, disableOptinPrefUrl: false } })
      );
    });

    test('nombre demasiado corto: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerApps.createApp({ name: 'abc' }, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('nombre demasiado largo: AppError 400 local, nunca llama a Gupshup', async () => {
      const nombreLargo = 'x'.repeat(151);
      await expect(partnerApps.createApp({ name: nombreLargo }, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('sin nombre: AppError 400 local', async () => {
      await expect(partnerApps.createApp({}, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('409 "Bot Already Exists" de Gupshup: se mapea a AppError 409 con mensaje claro', async () => {
      httpClient.request.mockRejectedValue(gupshupError(409, { message: 'Bot Already Exists' }));

      await expect(partnerApps.createApp({ name: 'CREAOS-duplicado' }, TOKEN)).rejects.toMatchObject({ statusCode: 409 });
    });

    test('400 real de Gupshup (caracteres inválidos, pasó la validación local): se mapea a AppError 400', async () => {
      httpClient.request.mockRejectedValue(gupshupError(400, { message: 'Invalid characters used in app name' }));

      await expect(partnerApps.createApp({ name: 'Nombre Válido En Longitud' }, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('setContactDetails()', () => {
    test('happy path: PUT /partner/app/{appId}/onboarding/contact', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success', message: 'contact details updated successfully' }, requestId: 'gsp_x' });

      const result = await partnerApps.setContactDetails('app-123', { contactEmail: 'a@b.com', contactName: 'Ana', contactNumber: '+51900000000' }, TOKEN);

      expect(result).toEqual({ status: 'success', message: 'contact details updated successfully' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PUT',
          path: '/partner/app/app-123/onboarding/contact',
          headers: { token: TOKEN },
          form: { contactEmail: 'a@b.com', contactName: 'Ana', contactNumber: '+51900000000' },
        })
      );
    });

    test('401 Authentication Failed: se mapea a AppError 401', async () => {
      httpClient.request.mockRejectedValue(gupshupError(401, { message: 'Authentication Failed' }));

      await expect(partnerApps.setContactDetails('app-123', {}, TOKEN)).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe('generateEmbedSignupLink()', () => {
    test('happy path: POST .../obotoembed/whitelist, devuelve embedSignupUrl', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { embedSignupUrl: 'https://gs.tc.im/abc', id: '1016427996774921', status: 'success' }, requestId: 'gsp_x' });

      const result = await partnerApps.generateEmbedSignupLink('app-123', TOKEN);

      expect(result).toEqual({ embedSignupUrl: 'https://gs.tc.im/abc', id: '1016427996774921' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '/partner/app/app-123/obotoembed/whitelist', headers: { token: TOKEN } })
      );
    });

    test('400 "Error while whitelisting WABA": se mapea a AppError 400', async () => {
      httpClient.request.mockRejectedValue(gupshupError(400, { message: 'Error while whitelisting WABA.' }));

      await expect(partnerApps.generateEmbedSignupLink('app-123', TOKEN)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('linkAppWithPartner()', () => {
    test('happy path: POST /partner/account/api/appLink', async () => {
      const partnerApps200 = { partnerApps: { id: 'abc', name: 'assistant0092', healthy: true } };
      httpClient.request.mockResolvedValue({ status: 200, body: partnerApps200, requestId: 'gsp_x' });

      const result = await partnerApps.linkAppWithPartner({ apiKey: 'apikey-real', appName: 'assistant0092' }, TOKEN);

      expect(result).toEqual(partnerApps200);
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/partner/account/api/appLink',
          headers: { token: TOKEN },
          form: { apiKey: 'apikey-real', appName: 'assistant0092' },
        })
      );
    });

    test('401 Unauthorized: se mapea a AppError 401', async () => {
      httpClient.request.mockRejectedValue(gupshupError(401, null));

      await expect(partnerApps.linkAppWithPartner({ apiKey: 'x', appName: 'y' }, TOKEN)).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe('verifyAndAttachCreditLine()', () => {
    test('happy path: GET .../obotoembed/verify', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success', message: 'Credit line added successfully for WABA id 123' }, requestId: 'gsp_x' });

      const result = await partnerApps.verifyAndAttachCreditLine('app-123', TOKEN);

      expect(result).toEqual({ status: 'success', message: 'Credit line added successfully for WABA id 123' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: '/partner/app/app-123/obotoembed/verify', headers: { token: TOKEN } })
      );
    });

    test('400 "WABA is not migrated to embed yet": se mapea a AppError 400 con el mensaje real', async () => {
      httpClient.request.mockRejectedValue(gupshupError(400, { message: 'WABA is not migrated to embed yet, ownership type: ON_BEHALF_OF' }));

      await expect(partnerApps.verifyAndAttachCreditLine('app-123', TOKEN)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('ownership type: ON_BEHALF_OF'),
      });
    });
  });

  describe('getEmbedSignupLink()', () => {
    test('happy path: GET .../onboarding/embed/link con user/lang/regenerate, devuelve link', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success', link: 'https://embed.gupshup.io/abc123' }, requestId: 'gsp_x' });

      const result = await partnerApps.getEmbedSignupLink('app-123', { user: 'ana@creaos.com', lang: 'es' }, TOKEN);

      expect(result).toEqual({ link: 'https://embed.gupshup.io/abc123' });
      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '/partner/app/app-123/onboarding/embed/link',
          headers: { token: TOKEN },
          query: { user: 'ana@creaos.com', lang: 'es', regenerate: false },
          idempotent: false,
        })
      );
    });

    test('regenerate:true se pasa tal cual cuando se pide explícito', async () => {
      httpClient.request.mockResolvedValue({ status: 200, body: { status: 'success', link: 'https://embed.gupshup.io/nuevo' }, requestId: 'gsp_x' });

      await partnerApps.getEmbedSignupLink('app-123', { user: 'ana@creaos.com', lang: 'es', regenerate: true }, TOKEN);

      expect(httpClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ query: { user: 'ana@creaos.com', lang: 'es', regenerate: true } })
      );
    });

    test('sin user: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerApps.getEmbedSignupLink('app-123', { lang: 'es' }, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('sin lang: AppError 400 local, nunca llama a Gupshup', async () => {
      await expect(partnerApps.getEmbedSignupLink('app-123', { user: 'ana@creaos.com' }, TOKEN)).rejects.toMatchObject({ statusCode: 400 });
      expect(httpClient.request).not.toHaveBeenCalled();
    });

    test('401 Authentication Failed (appId o token incorrecto): se mapea a AppError 401', async () => {
      httpClient.request.mockRejectedValue(gupshupError(401, { status: 'error', message: 'Authentication Failed' }));

      await expect(partnerApps.getEmbedSignupLink('app-123', { user: 'ana@creaos.com', lang: 'es' }, TOKEN)).rejects.toMatchObject({ statusCode: 401 });
    });

    test('500 "Max link already sent": se mapea a AppError 502 (falla del proveedor)', async () => {
      httpClient.request.mockRejectedValue(gupshupError(500, { status: 'error', message: 'Max link already sent' }));

      await expect(partnerApps.getEmbedSignupLink('app-123', { user: 'ana@creaos.com', lang: 'es' }, TOKEN)).rejects.toMatchObject({ statusCode: 502 });
    });
  });
});
