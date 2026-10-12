const crypto = require('crypto');
const { encrypt, decrypt } = require('../channels/channelCrypto');

const CRYPTO_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const SECRET_FIELDS = ['verifyToken', 'accessToken'];
const SECRET_SELECT = '+verifyToken +accessToken +verifyTokenEncrypted +accessTokenEncrypted';
const LOOKUP_PREFIX = `enc:v${CRYPTO_VERSION}:`;

const encryptedFieldName = (field) => `${field}Encrypted`;

const assertSecretField = (field) => {
  if (!SECRET_FIELDS.includes(field)) throw new Error('webhook_secret_field_not_supported');
};

const contextId = (record, field) => `webhookconfig:${record._id}:${field}`;

const lookupMarker = (value) => `${LOOKUP_PREFIX}${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;

const isLookupMarker = (value) => typeof value === 'string'
  && /^enc:v1:[a-f0-9]{64}$/i.test(value);

const encryptSecret = (value, record, field) => {
  assertSecretField(field);
  if (!record?._id) throw new Error('webhook_secret_record_id_required');
  if (typeof value !== 'string' || value.length === 0) return null;
  return {
    version: CRYPTO_VERSION,
    algorithm: ALGORITHM,
    ...encrypt(value, contextId(record, field)),
  };
};

const decryptSecret = (encrypted, record, field) => {
  assertSecretField(field);
  if (!encrypted) return null;
  try {
    if (encrypted.version !== CRYPTO_VERSION || encrypted.algorithm !== ALGORITHM) {
      throw new Error('unsupported_crypto_version');
    }
    return decrypt(encrypted, contextId(record, field));
  } catch (_error) {
    throw new Error(`webhook_secret_decryption_failed:${field}`);
  }
};

const readSecret = (record, field) => {
  assertSecretField(field);
  if (!record) return null;
  const encrypted = record[encryptedFieldName(field)];
  if (encrypted) return decryptSecret(encrypted, record, field);

  const legacy = record[field];
  if (typeof legacy === 'string' && legacy.length > 0 && !isLookupMarker(legacy)) return legacy;
  if (isLookupMarker(legacy)) throw new Error(`webhook_secret_decryption_failed:${field}`);
  return null;
};

const setSecret = (record, field, value) => {
  assertSecretField(field);
  if (value === null || value === undefined || value === '') {
    record.set(encryptedFieldName(field), null);
    record.set(field, undefined);
    return;
  }
  if (typeof value !== 'string') throw new Error(`webhook_secret_invalid:${field}`);

  record.set(encryptedFieldName(field), encryptSecret(value, record, field));
  record.set(field, field === 'verifyToken' ? lookupMarker(value) : undefined);
};

const hasSecret = (record, field) => {
  assertSecretField(field);
  return Boolean(record?.[encryptedFieldName(field)]
    || (typeof record?.[field] === 'string' && record[field].length > 0 && !isLookupMarker(record[field])));
};

const safeEqual = (left, right) => {
  const a = Buffer.from(left || '', 'utf8');
  const b = Buffer.from(right || '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const findByVerifyToken = async (WebhookConfig, token, extraFilter = {}) => {
  if (typeof token !== 'string' || token.length === 0) return null;

  let config = await WebhookConfig.findOne({
    ...extraFilter,
    verifyToken: lookupMarker(token),
  }).select(SECRET_SELECT);

  if (config) {
    const decrypted = readSecret(config, 'verifyToken');
    if (!safeEqual(decrypted, token)) throw new Error('webhook_secret_verification_failed');
    return config;
  }

  // Compatibilidad temporal: los registros pre-P0-B todavía se consultan
  // por plaintext hasta ejecutar scripts/migrate-webhook-secrets.js --apply.
  config = await WebhookConfig.findOne({ ...extraFilter, verifyToken: token }).select(SECRET_SELECT);
  return config || null;
};

module.exports = {
  ALGORITHM,
  CRYPTO_VERSION,
  LOOKUP_PREFIX,
  SECRET_FIELDS,
  SECRET_SELECT,
  decryptSecret,
  encryptSecret,
  findByVerifyToken,
  hasSecret,
  isLookupMarker,
  lookupMarker,
  readSecret,
  setSecret,
};
