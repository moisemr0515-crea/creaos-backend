// channelCrypto.js — cifrado de credenciales de canal por tenant (Fase 2.0
// del blueprint Meta+Gupshup Embedded Signup).
//
// NUNCA cifra directo con CHANNEL_CREDENTIALS_KEY (la clave maestra) — cada
// canal deriva su propia subclave vía HKDF, usando el channelId como parte
// del contexto de derivación (`info`). Esto es defensa en profundidad, no
// una solución completa: si la clave MAESTRA se filtra entera, HKDF no
// ayuda en nada (es una función pública y determinística — con la clave
// maestra y el channelId, que no es secreto, cualquiera deriva la misma
// subclave que la app). Lo que SÍ contiene es un incidente más acotado —
// una subclave derivada capturada en un log puntual, un dump de memoria en
// el momento exacto de un descifrado — al canal afectado, no a los otros
// 99 tenants. La mitigación real contra la clave maestra filtrada es
// operacional: nunca loguearla, control de acceso a Railway, y keyVersion
// (abajo) para poder rotarla sin re-cifrar todo de golpe.
const crypto = require('crypto');
const { CHANNEL_CREDENTIALS_KEY } = require('../../config/env');

// Sube cuando se rote CHANNEL_CREDENTIALS_KEY — cada credencial cifrada
// guarda con qué versión se cifró (ver channelCredentials.model.js), así
// que rotar la clave maestra no exige re-cifrar todo en el mismo instante:
// las credenciales viejas siguen descifrándose con su keyVersion original
// hasta que se re-cifren una por una.
const CURRENT_KEY_VERSION = 1;

function masterKeyBuffer() {
  if (!CHANNEL_CREDENTIALS_KEY) {
    throw new Error('CHANNEL_CREDENTIALS_KEY no está configurado');
  }
  const buffer = Buffer.from(CHANNEL_CREDENTIALS_KEY, 'hex');
  if (buffer.length !== 32) {
    throw new Error('CHANNEL_CREDENTIALS_KEY debe ser 32 bytes en hex (64 caracteres) — generar con `openssl rand -hex 32`');
  }
  return buffer;
}

/**
 * Deriva la subclave de un canal específico a partir de la clave maestra.
 * `info` incluye el channelId (contexto de dominio, no secreto) y la
 * versión de la clave maestra — dos canales nunca comparten subclave, y
 * una futura rotación de CHANNEL_CREDENTIALS_KEY puede convivir con datos
 * cifrados bajo versiones anteriores mientras se re-cifran de a poco.
 *
 * @param {string} channelId
 * @param {number} [keyVersion]
 * @returns {Buffer} 32 bytes
 */
function deriveChannelKey(channelId, keyVersion = CURRENT_KEY_VERSION) {
  const derived = crypto.hkdfSync(
    'sha256',
    masterKeyBuffer(),
    Buffer.alloc(0), // salt — vacío a propósito, el contexto real va en `info`
    `channelcreds:v${keyVersion}:${channelId}`,
    32
  );
  return Buffer.from(derived);
}

/**
 * @param {string} plaintext
 * @param {string} channelId
 * @returns {{ ciphertext: string, iv: string, authTag: string, keyVersion: number }}
 *   Todo en base64 salvo keyVersion. Shape 1:1 con cipherFieldSchema
 *   (channelCredentials.model.js).
 */
function encrypt(plaintext, channelId) {
  const key = deriveChannelKey(channelId);
  const iv = crypto.randomBytes(12); // 96 bits — tamaño recomendado para GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * @param {{ ciphertext: string, iv: string, authTag: string, keyVersion: number }} field
 * @param {string} channelId
 * @returns {string} el plaintext original
 * @throws si el authTag no matchea (dato corrupto o subclave equivocada —
 *   GCM lo detecta y createDecipheriv/final() tira) o si falta
 *   CHANNEL_CREDENTIALS_KEY. Nunca devuelve un resultado silencioso ante
 *   un dato roto — quien llama decide qué hacer con el error (ver
 *   channelCredentials.service.js#resolveCredentials()).
 */
function decrypt(field, channelId) {
  const key = deriveChannelKey(channelId, field.keyVersion);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(field.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(field.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(field.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt, deriveChannelKey, CURRENT_KEY_VERSION };
