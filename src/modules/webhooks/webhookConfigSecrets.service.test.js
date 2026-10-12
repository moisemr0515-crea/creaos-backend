process.env.CHANNEL_CREDENTIALS_KEY = require('crypto').randomBytes(32).toString('hex');

jest.mock('../users/userScope.service', () => ({
  assertActiveUserInBusiness: jest.fn().mockResolvedValue(null),
}));

const mongoose = require('mongoose');
const WebhookConfig = require('./webhookConfig.model');
const {
  SECRET_SELECT,
  decryptSecret,
  encryptSecret,
  findByVerifyToken,
  lookupMarker,
  readSecret,
  setSecret,
} = require('./webhookConfigSecrets.service');
const { migrateWebhookSecrets } = require('./webhookConfigMigration.service');
const { createConfig, testWebhook } = require('./webhook.controller');
const { processMetaLead } = require('./webhook.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_webhook_config_secrets';
const BUSINESS_ID = new mongoose.Types.ObjectId();
const SECRET = 'token-super-secreto-de-prueba';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

const createEncryptedConfig = async () => {
  const config = new WebhookConfig({ business: BUSINESS_ID, platform: 'meta', pageId: 'page-1' });
  setSecret(config, 'verifyToken', 'verify-token');
  setSecret(config, 'accessToken', SECRET);
  await config.save();
  return config;
};

describe('WebhookConfig encrypted credentials', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await WebhookConfig.init();
  });

  afterAll(async () => {
    await WebhookConfig.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await WebhookConfig.deleteMany({});
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('AES-256-GCM roundtrip conserva el plaintext y ciphertext nunca lo contiene', () => {
    const record = { _id: new mongoose.Types.ObjectId() };
    const encrypted = encryptSecret(SECRET, record, 'accessToken');
    expect(encrypted).toMatchObject({ version: 1, algorithm: 'aes-256-gcm', keyVersion: 1 });
    expect(JSON.stringify(encrypted)).not.toContain(SECRET);
    expect(decryptSecret(encrypted, record, 'accessToken')).toBe(SECRET);
  });

  test('dos cifrados del mismo token usan IV y ciphertext distintos', () => {
    const record = { _id: new mongoose.Types.ObjectId() };
    const first = encryptSecret(SECRET, record, 'accessToken');
    const second = encryptSecret(SECRET, record, 'accessToken');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  test('GCM detecta manipulación y falla cerrado sin incluir el secreto', () => {
    const record = { _id: new mongoose.Types.ObjectId() };
    const encrypted = encryptSecret(SECRET, record, 'accessToken');
    const tamperedTag = Buffer.from(encrypted.authTag, 'base64');
    tamperedTag[0] ^= 0xff;
    encrypted.authTag = tamperedTag.toString('base64');
    expect(() => decryptSecret(encrypted, record, 'accessToken'))
      .toThrow('webhook_secret_decryption_failed:accessToken');
  });

  test('registro legacy plaintext sigue siendo legible durante la transición', async () => {
    await WebhookConfig.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      business: BUSINESS_ID,
      platform: 'meta',
      verifyToken: 'legacy-verify',
      accessToken: SECRET,
      isActive: true,
    });
    const config = await WebhookConfig.findOne({ verifyToken: 'legacy-verify' }).select(SECRET_SELECT);
    expect(readSecret(config, 'verifyToken')).toBe('legacy-verify');
    expect(readSecret(config, 'accessToken')).toBe(SECRET);
    await expect(findByVerifyToken(WebhookConfig, 'legacy-verify', { platform: 'meta' }))
      .resolves.toBeTruthy();
  });

  test('nueva escritura y actualización nunca persisten plaintext', async () => {
    const config = await createEncryptedConfig();
    let raw = await WebhookConfig.collection.findOne({ _id: config._id });
    expect(raw.verifyToken).toBe(lookupMarker('verify-token'));
    expect(raw.accessToken).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(SECRET);
    expect(decryptSecret(raw.accessTokenEncrypted, raw, 'accessToken')).toBe(SECRET);

    const selected = await WebhookConfig.findById(config._id).select(SECRET_SELECT);
    setSecret(selected, 'accessToken', 'token-actualizado');
    await selected.save();
    raw = await WebhookConfig.collection.findOne({ _id: config._id });
    expect(raw.accessToken).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain('token-actualizado');
    expect(decryptSecret(raw.accessTokenEncrypted, raw, 'accessToken')).toBe('token-actualizado');
  });

  test('null/empty limpia la credencial sin romper', async () => {
    const config = await createEncryptedConfig();
    const selected = await WebhookConfig.findById(config._id).select(SECRET_SELECT);
    setSecret(selected, 'accessToken', null);
    await selected.save();
    const raw = await WebhookConfig.collection.findOne({ _id: config._id });
    expect(raw.accessToken).toBeUndefined();
    expect(raw.accessTokenEncrypted).toBeNull();
  });

  test('Meta usa el accessToken descifrado solo en memoria', async () => {
    const config = await createEncryptedConfig();
    const selected = await WebhookConfig.findById(config._id).select(SECRET_SELECT);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ field_data: [] }),
    });
    const result = await processMetaLead({
      changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-1', form_id: 'form-1', page_id: 'page-1' } }],
    }, selected);
    expect(result).toEqual([{ leadgenId: 'lead-1', status: 'skipped', reason: 'no_identifiable_data' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('access_token=');
  });

  test('accessToken corrupto falla cerrado antes de llamar Meta', async () => {
    const config = await createEncryptedConfig();
    const raw = await WebhookConfig.collection.findOne({ _id: config._id });
    raw.accessTokenEncrypted.authTag = Buffer.alloc(16, 0).toString('base64');
    await WebhookConfig.collection.updateOne(
      { _id: config._id },
      { $set: { accessTokenEncrypted: raw.accessTokenEncrypted } }
    );
    const selected = await WebhookConfig.findById(config._id).select(SECRET_SELECT);
    const fetchSpy = jest.spyOn(global, 'fetch');
    const result = await processMetaLead({
      changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-corrupt', form_id: 'form-1', page_id: 'page-1' } }],
    }, selected);
    expect(result[0]).toMatchObject({ leadgenId: 'lead-corrupt', status: 'error' });
    expect(result[0].error).toBe('webhook_secret_decryption_failed:accessToken');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('serialización y endpoints administrativos no exponen secretos ni ciphertext', async () => {
    const req = {
      businessId: BUSINESS_ID,
      body: { platform: 'meta', accessToken: SECRET, pageId: 'page-api', defaults: {} },
    };
    const res = mockRes();
    const next = jest.fn();
    await createConfig(req, res, next);
    expect(next).not.toHaveBeenCalled();
    const payload = JSON.stringify(res.json.mock.calls[0][0]);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toMatch(/"verifyToken":|"accessToken":|"ciphertext":|"authTag":/);

    const created = await WebhookConfig.findOne({ pageId: 'page-api' });
    const testRes = mockRes();
    await testWebhook({ businessId: BUSINESS_ID, params: { configId: created._id } }, testRes, next);
    const testPayload = JSON.stringify(testRes.json.mock.calls[0][0]);
    expect(testPayload).toContain('verifyTokenConfigured');
    expect(testPayload).not.toMatch(/"verifyToken":|ciphertext|authTag/);
  });

  test('dry-run detecta legacy pero no modifica datos ni registra el token', async () => {
    const id = new mongoose.Types.ObjectId();
    await WebhookConfig.collection.insertOne({
      _id: id,
      business: BUSINESS_ID,
      platform: 'tiktok',
      verifyToken: 'legacy-dry',
      accessToken: SECRET,
      isActive: true,
    });
    const reports = [];
    const results = await migrateWebhookSecrets({ WebhookConfig, apply: false, report: (entry) => reports.push(entry) });
    expect(results.map((entry) => entry.status)).toEqual(['WOULD_MIGRATE', 'WOULD_MIGRATE']);
    const raw = await WebhookConfig.collection.findOne({ _id: id });
    expect(raw.verifyToken).toBe('legacy-dry');
    expect(raw.accessToken).toBe(SECRET);
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    expect(JSON.stringify(reports)).not.toContain('legacy-dry');
  });

  test('migración legacy cifra, verifica, elimina plaintext y es idempotente', async () => {
    const id = new mongoose.Types.ObjectId();
    await WebhookConfig.collection.insertOne({
      _id: id,
      business: BUSINESS_ID,
      platform: 'meta',
      verifyToken: 'legacy-apply',
      accessToken: SECRET,
      isActive: true,
    });
    const first = await migrateWebhookSecrets({ WebhookConfig, apply: true });
    expect(first.map((entry) => entry.status)).toEqual(['MIGRATED', 'MIGRATED']);
    const raw = await WebhookConfig.collection.findOne({ _id: id });
    expect(raw.verifyToken).toBe(lookupMarker('legacy-apply'));
    expect(raw.accessToken).toBeUndefined();
    expect(decryptSecret(raw.verifyTokenEncrypted, raw, 'verifyToken')).toBe('legacy-apply');
    expect(decryptSecret(raw.accessTokenEncrypted, raw, 'accessToken')).toBe(SECRET);

    const second = await migrateWebhookSecrets({ WebhookConfig, apply: true });
    expect(second.map((entry) => entry.status)).toEqual(['ALREADY_ENCRYPTED', 'ALREADY_ENCRYPTED']);
    await expect(findByVerifyToken(WebhookConfig, 'legacy-apply', { platform: 'meta' }))
      .resolves.toBeTruthy();
  });

  test('campos vacíos se omiten y un ciphertext corrupto se reporta sin frenar otros registros', async () => {
    const emptyId = new mongoose.Types.ObjectId();
    const corruptId = new mongoose.Types.ObjectId();
    await WebhookConfig.collection.insertMany([
      { _id: emptyId, business: BUSINESS_ID, platform: 'meta', verifyToken: '', isActive: true },
      {
        _id: corruptId,
        business: BUSINESS_ID,
        platform: 'tiktok',
        verifyToken: lookupMarker('corrupto'),
        verifyTokenEncrypted: {
          version: 1,
          algorithm: 'aes-256-gcm',
          ciphertext: 'AAAA',
          iv: 'AAAA',
          authTag: 'AAAA',
          keyVersion: 1,
        },
        isActive: true,
      },
    ]);
    const results = await migrateWebhookSecrets({ WebhookConfig, apply: true });
    const byId = (id, field) => results.find((entry) => entry.recordId === String(id) && entry.field === field);
    expect(byId(emptyId, 'verifyToken').status).toBe('SKIPPED_EMPTY');
    expect(byId(emptyId, 'accessToken').status).toBe('SKIPPED_EMPTY');
    expect(byId(corruptId, 'verifyToken')).toMatchObject({ status: 'FAILED', reason: 'DECRYPTION_FAILED' });
    expect(byId(corruptId, 'accessToken').status).toBe('SKIPPED_EMPTY');
  });
});
