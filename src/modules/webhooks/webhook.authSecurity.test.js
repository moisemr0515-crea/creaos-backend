const crypto = require('crypto');

const loadService = ({ nodeEnv = 'production', meta = '', tiktok = '', gupshup = '' } = {}) => {
  jest.resetModules();
  jest.doMock('../../config/env', () => ({
    NODE_ENV: nodeEnv,
    META_APP_SECRET: meta,
    META_GRAPH_API_VERSION: 'v19.0',
    TIKTOK_APP_SECRET: tiktok,
    GUPSHUP_WEBHOOK_TOKEN: gupshup,
  }));
  jest.doMock('../ai/ai.service', () => ({}));
  return require('./webhook.service');
};

describe('autenticación criptográfica de webhooks', () => {
  const rawBody = Buffer.from('{"event":"test"}');

  test('Meta: firma correcta se acepta e incorrecta/ausente se rechaza en production', () => {
    const secret = 'meta-secret';
    const service = loadService({ meta: secret });
    const valid = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    expect(service.verifyMetaSignature(rawBody, valid)).toBe(true);
    expect(service.verifyMetaSignature(rawBody, 'sha256=incorrecta')).toBe(false);
    expect(service.verifyMetaSignature(rawBody, '')).toBe(false);
  });

  test('secretos ausentes de Meta, Gupshup y TikTok se rechazan en production', () => {
    const service = loadService();
    expect(service.verifyMetaSignature(rawBody, 'sha256=cualquiera')).toBe(false);
    expect(service.verifyGupshupAuth({ 'x-gupshup-webhook-token': 'cualquiera' })).toBe(false);
    expect(service.verifyTikTokSignature(rawBody, '123', 'abc', 'cualquiera')).toBe(false);
  });

  test('Gupshup: token correcto se acepta e incorrecto/ausente se rechaza en production', () => {
    const service = loadService({ gupshup: 'gs-secret' });
    expect(service.verifyGupshupAuth({ 'x-gupshup-webhook-token': 'gs-secret' })).toBe(true);
    expect(service.verifyGupshupAuth({ 'x-gupshup-webhook-token': 'otro' })).toBe(false);
    expect(service.verifyGupshupAuth({})).toBe(false);
  });

  test('TikTok: firma correcta se acepta e incorrecta/ausente se rechaza en production', () => {
    const secret = 'tt-secret';
    const timestamp = '123';
    const nonce = 'abc';
    const service = loadService({ tiktok: secret });
    const valid = crypto.createHash('sha256').update([secret, timestamp, nonce, rawBody].sort().join('')).digest('hex');

    expect(service.verifyTikTokSignature(rawBody, timestamp, nonce, valid)).toBe(true);
    expect(service.verifyTikTokSignature(rawBody, timestamp, nonce, 'incorrecta')).toBe(false);
    expect(service.verifyTikTokSignature(rawBody, timestamp, nonce, '')).toBe(false);
  });

  test('development/test conserva el bypass solo cuando el secreto no está configurado', () => {
    const service = loadService({ nodeEnv: 'test' });
    expect(service.verifyMetaSignature(rawBody, '')).toBe(true);
    expect(service.verifyGupshupAuth({})).toBe(true);
    expect(service.verifyTikTokSignature(rawBody, '', '', '')).toBe(true);
  });
});
