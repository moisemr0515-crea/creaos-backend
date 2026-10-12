const {
  SECRET_FIELDS,
  decryptSecret,
  encryptSecret,
  isLookupMarker,
  lookupMarker,
} = require('./webhookConfigSecrets.service');

const encryptedFieldName = (field) => `${field}Encrypted`;

const finalizePlaintextRemoval = async (collection, record, field, plaintext) => {
  const filter = { _id: record._id };
  if (field === 'verifyToken') {
    filter.verifyToken = plaintext;
    return collection.updateOne(filter, { $set: { verifyToken: lookupMarker(plaintext) } });
  }
  filter.accessToken = plaintext;
  return collection.updateOne(filter, { $unset: { accessToken: '' } });
};

const migrateField = async ({ collection, record, field, apply }) => {
  const encryptedName = encryptedFieldName(field);
  const encrypted = record[encryptedName];
  const legacy = record[field];
  const legacyPlaintext = typeof legacy === 'string' && legacy.length > 0 && !isLookupMarker(legacy)
    ? legacy
    : null;

  if (encrypted) {
    let decrypted;
    try {
      decrypted = decryptSecret(encrypted, record, field);
    } catch (_error) {
      return { status: 'FAILED', reason: 'DECRYPTION_FAILED' };
    }

    if (legacyPlaintext && decrypted !== legacyPlaintext) {
      return { status: 'FAILED', reason: 'PLAINTEXT_CIPHERTEXT_MISMATCH' };
    }
    if (!legacyPlaintext) return { status: 'ALREADY_ENCRYPTED' };
    if (!apply) return { status: 'WOULD_REMOVE_PLAINTEXT' };

    const finalized = await finalizePlaintextRemoval(collection, record, field, legacyPlaintext);
    return finalized.modifiedCount === 1
      ? { status: 'MIGRATED' }
      : { status: 'FAILED', reason: 'CONCURRENT_UPDATE' };
  }

  if (field === 'verifyToken' && isLookupMarker(legacy)) {
    return { status: 'FAILED', reason: 'CIPHERTEXT_MISSING' };
  }
  if (!legacyPlaintext) return { status: 'SKIPPED_EMPTY' };
  if (!apply) return { status: 'WOULD_MIGRATE' };

  const generated = encryptSecret(legacyPlaintext, record, field);
  if (decryptSecret(generated, record, field) !== legacyPlaintext) {
    return { status: 'FAILED', reason: 'IN_MEMORY_VERIFICATION_FAILED' };
  }

  // Fase 1: persiste ciphertext manteniendo todavía el plaintext. Si el
  // proceso cae aquí, el siguiente --apply verifica ambos y termina limpio.
  const staged = await collection.updateOne(
    {
      _id: record._id,
      [field]: legacyPlaintext,
      $or: [{ [encryptedName]: { $exists: false } }, { [encryptedName]: null }],
    },
    { $set: { [encryptedName]: generated } }
  );
  if (staged.modifiedCount !== 1) return { status: 'FAILED', reason: 'CONCURRENT_UPDATE' };

  // Fase 2: relee y verifica el ciphertext realmente persistido.
  const persisted = await collection.findOne({ _id: record._id });
  try {
    if (decryptSecret(persisted?.[encryptedName], persisted, field) !== legacyPlaintext) {
      return { status: 'FAILED', reason: 'PERSISTED_VERIFICATION_FAILED' };
    }
  } catch (_error) {
    return { status: 'FAILED', reason: 'PERSISTED_VERIFICATION_FAILED' };
  }

  // Fase 3: solo después de verificar elimina el plaintext (o lo sustituye
  // por el hash de consulta en verifyToken para conservar el índice unique).
  const finalized = await finalizePlaintextRemoval(collection, persisted, field, legacyPlaintext);
  return finalized.modifiedCount === 1
    ? { status: 'MIGRATED' }
    : { status: 'FAILED', reason: 'FINALIZE_CONCURRENT_UPDATE' };
};

const migrateWebhookSecrets = async ({ WebhookConfig, apply = false, report = () => {} }) => {
  const records = await WebhookConfig.collection.find({}).toArray();
  const results = [];

  for (const record of records) {
    for (const field of SECRET_FIELDS) {
      let result;
      try {
        result = await migrateField({ collection: WebhookConfig.collection, record, field, apply });
      } catch (_error) {
        result = { status: 'FAILED', reason: 'UNEXPECTED_ERROR' };
      }
      const entry = {
        provider: record.platform || 'unknown',
        recordId: String(record._id),
        field,
        ...result,
      };
      results.push(entry);
      report(entry);
    }
  }

  return results;
};

module.exports = { migrateField, migrateWebhookSecrets };
