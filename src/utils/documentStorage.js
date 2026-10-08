const crypto = require('crypto');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../config/env');
const { AppError } = require('../middleware/error.middleware');

const REQUIRED_CONFIG = [
  'DOCUMENT_STORAGE_BUCKET',
  'DOCUMENT_STORAGE_REGION',
  'DOCUMENT_STORAGE_ACCESS_KEY_ID',
  'DOCUMENT_STORAGE_SECRET_ACCESS_KEY',
];

const hasValue = (value) => typeof value === 'string' && value.trim().length > 0;

const isConfigured = () =>
  env.DOCUMENT_STORAGE_PROVIDER === 's3'
  && REQUIRED_CONFIG.every((name) => hasValue(env[name]));

const assertConfigured = () => {
  if (!isConfigured()) {
    throw new AppError(
      'El almacenamiento documental no está configurado. No se puede guardar un brochure mayor al límite de Cloudinary.',
      503
    );
  }
};

let client;
const getClient = () => {
  assertConfigured();
  if (!client) {
    client = new S3Client({
      region: env.DOCUMENT_STORAGE_REGION,
      ...(hasValue(env.DOCUMENT_STORAGE_ENDPOINT) ? { endpoint: env.DOCUMENT_STORAGE_ENDPOINT } : {}),
      forcePathStyle: env.DOCUMENT_STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.DOCUMENT_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: env.DOCUMENT_STORAGE_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
};

const safeName = (filename) => {
  const ext = path.extname(filename || '').toLowerCase() === '.pdf' ? '.pdf' : '.pdf';
  return `${crypto.randomUUID()}${ext}`;
};

const createStorageKey = (businessId, filename) =>
  `businesses/${String(businessId)}/brochures/${safeName(filename)}`;

const assertTenantKey = (businessId, storageKey) => {
  const prefix = `businesses/${String(businessId)}/brochures/`;
  if (!hasValue(storageKey) || !storageKey.startsWith(prefix)) {
    throw new AppError('El documento no pertenece a este negocio', 403);
  }
};

const uploadDocument = async ({ businessId, file }) => {
  assertConfigured();
  const storageKey = createStorageKey(businessId, file.originalname);
  await getClient().send(new PutObjectCommand({
    Bucket: env.DOCUMENT_STORAGE_BUCKET,
    Key: storageKey,
    Body: file.buffer,
    ContentType: file.mimetype,
    ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.originalname || 'brochure.pdf')}`,
    Metadata: {
      businessid: String(businessId),
      originalname: encodeURIComponent(file.originalname || 'brochure.pdf'),
    },
  }));
  return { storageKey };
};

const createSignedAccessUrl = async ({ businessId, storageKey, purpose = 'display' }) => {
  assertConfigured();
  assertTenantKey(businessId, storageKey);
  const expiresIn = purpose === 'send' ? 48 * 60 * 60 : 15 * 60;
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.DOCUMENT_STORAGE_BUCKET, Key: storageKey }),
    { expiresIn }
  );
};

const deleteDocument = async ({ businessId, storageKey }) => {
  assertConfigured();
  assertTenantKey(businessId, storageKey);
  await getClient().send(new DeleteObjectCommand({
    Bucket: env.DOCUMENT_STORAGE_BUCKET,
    Key: storageKey,
  }));
};

module.exports = {
  REQUIRED_CONFIG,
  isConfigured,
  createStorageKey,
  assertTenantKey,
  uploadDocument,
  createSignedAccessUrl,
  deleteDocument,
};
