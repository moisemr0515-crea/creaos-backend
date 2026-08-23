const mongoose = require('mongoose');

// ChannelCredentials — Fase 2.0 del blueprint Meta+Gupshup Embedded Signup.
// Colección separada de WhatsAppChannel a propósito, no un subdocumento
// embebido — 2 razones concretas:
//
// 1. La multiplicidad no encaja. appToken es reemplazo-en-el-lugar (1
//    activo a la vez, Gupshup no permite revocación selectiva de este —
//    regenerar invalida el anterior). apiKey en cambio SÍ soporta varias
//    activas simultáneamente, cada una revocable por separado (confirmado
//    en el Partner Portal) — eso ya es, de por sí, un array con su propio
//    ciclo de vida, no un par de campos planos.
// 2. Higiene de acceso. channelResolver.resolve() se llama en CADA webhook
//    entrante — si las credenciales cifradas vivieran embebidas en
//    WhatsAppChannel, cualquier query normal sobre ese documento (incluidas
//    las que solo necesitan resolver tenant, no mandar nada) traería
//    secretos cifrados de más. Separado, nadie los toca salvo
//    channelCredentials.service.js#resolveCredentials().
const PROVIDERS = ['gupshup'];

// Shape común a appToken.current y a cada entrada de apiKeys — ver
// channelCrypto.js#encrypt() para el significado exacto de cada campo.
const cipherFieldSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true }, // AES-256-GCM, base64
    iv:         { type: String, required: true }, // IV aleatorio POR cifrado, base64
    authTag:    { type: String, required: true }, // GCM auth tag, base64
    // Qué "epoch" de CHANNEL_CREDENTIALS_KEY cifró esto — permite rotar la
    // clave maestra sin tener que re-cifrar todas las credenciales
    // existentes en el mismo instante (se re-cifran de a poco, sabiendo
    // cuáles quedan todavía con la versión vieja).
    keyVersion: { type: Number, required: true },
  },
  { _id: false }
);

const apiKeyEntrySchema = new mongoose.Schema(
  {
    value: { type: cipherFieldSchema, required: true },
    // Ayuda a un humano a elegir cuál revocar cuando hay varias activas —
    // ej. "primaria", "backup". Opcional, sin validación de unicidad.
    label:     { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    // null = activa. revocar es soft — nunca se borra la entrada, queda
    // como registro de auditoría de que existió y cuándo/quién/por qué se
    // revocó (mismo criterio de soft-delete que el resto del repo).
    //
    // LIMITACIÓN CONOCIDA: este campo refleja el estado que CREA OS
    // conoce, NO está sincronizado en tiempo real con Gupshup. Si alguien
    // revoca una key directo desde el Partner Portal de Gupshup (fuera de
    // CREA OS), este documento sigue mostrándola como activa hasta que
    // algo la actualice — a mano, o vía una sincronización futura contra
    // Gupshup (todavía no existe; depende de si sus APIs exponen el
    // estado real de una key, ver blueprint §5/pregunta 09).
    revokedAt:     { type: Date, default: null },
    revokedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokedReason: { type: String, default: null },
  }
);

const channelCredentialsSchema = new mongoose.Schema(
  {
    channel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppChannel',
      required: true,
      unique: true, // un documento por canal — apiKeys[] ya cubre "varias credenciales"
    },
    // Denormalizado — mismo criterio que Conversation.business en el resto
    // del repo: permite un "revocar todo de este tenant" en un incidente
    // real, sin depender de un populate hacia WhatsAppChannel.
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    provider: { type: String, enum: PROVIDERS, required: true },

    appToken: {
      current: { type: cipherFieldSchema, default: null },
      // Solo metadata — nunca el ciphertext viejo. El token anterior ya
      // quedó inválido al regenerar (Gupshup no permite revocación
      // selectiva de este), no hay nada real que descifrar de él después.
      history: [
        {
          regeneratedAt: Date,
          regeneratedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
      ],
    },

    apiKeys: [apiKeyEntrySchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChannelCredentials', channelCredentialsSchema);
module.exports.PROVIDERS = PROVIDERS;
