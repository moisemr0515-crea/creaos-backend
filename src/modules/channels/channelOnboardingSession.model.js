const mongoose = require('mongoose');
const crypto = require('crypto');

// ChannelOnboardingSession — Fase 2.1 del blueprint Meta+Gupshup Embedded
// Signup (docs/implementation/fase-2.1-blueprint-final.md, §1.1). Trackea el
// progreso de un intento de onboarding (Meta auth → selección WABA/número →
// registro en Gupshup) DESDE ANTES de que exista un WhatsAppChannel real —
// ese modelo exige phoneNumber/phoneNumberId desde el día 1 (`required`), así
// que no hay dónde guardar el progreso intermedio si no es acá.
//
// Mismo criterio de "colección de auditoría" que InboundEvent
// (inboundEvent.model.js): nunca se hard-borra, ni siquiera al completarse
// el onboarding (Decisión 2 del blueprint) — por eso NO hay ningún índice
// TTL sobre `expiresAt`, a propósito. Ese campo es de solo lectura para la
// app: decide cuándo una sesión colgada pasa a `expired` (transición
// perezosa, hecha por quien la lee después de vencida — ver §4.4 del
// blueprint), nunca dispara un borrado automático de Mongo.
//
// v1 (PR 1): solo el modelo. Sin controller/routes/service todavía — el
// primer productor real es la sub-fase de `init`/`callback` (PR 5 del
// blueprint).

const STATUSES = [
  'initiated', // init() creó la sesión, esperando que el usuario complete el popup de Meta
  // Fix de idempotencia/race condition (ver channel.controller.js#claimSessionForStep()
  // y channelOnboardingCompletion.service.js#handleGupshupAccountVerified()):
  // los 3 estados marcados "reclamo atómico" de abajo son transitorios — nadie
  // los deja así a propósito, existen solo para que 2 requests concurrentes
  // sobre la MISMA sesión (reintento de red, doble entrega de un webhook,
  // doble click) no puedan pisarse el resultado. Mismo patrón que
  // OutboundEvent.status:'processing' en outbound.worker.js.
  'exchanging_code', // reclamo atómico de /code: canjeando el code de Meta, todavía no confirmado
  'meta_authorized', // callback recibido: code canjeado, WABA + número ya elegidos en Meta
  'resolving_number', // reclamo atómico de /callback: resolviendo el phoneNumber real con Meta
  'gupshup_registering', // complete-onboarding en curso: registrando el número en Gupshup Partner API
  'completing', // reclamo atómico del webhook ACCOUNT_VERIFIED: creando WhatsAppChannel/ChannelCredentials
  'completed', // WhatsAppChannel + ChannelCredentials creados, canal operativo
  'failed', // algún paso falló de forma terminal (no reintentable sin volver a init)
  'expired', // el usuario nunca volvió del popup de Meta dentro de la ventana esperada
];

const PROVIDERS = ['gupshup'];

const EXPIRACION_MS = 30 * 60 * 1000; // 30 minutos — ventana esperada para completar el popup de Meta

// Mismo shape que cipherFieldSchema (channelCredentials.model.js) — se
// duplica acá, no se importa, porque channelCredentials.model.js no lo
// exporta (es intencionalmente privado a ese archivo) y este modelo no
// necesita nada más que el shape. Ver channelCrypto.js#encrypt() para el
// significado exacto de cada campo.
//
// Quien puebla este campo (PR 5, en el handler de `callback`) cifra el
// access token de negocio que devuelve Meta usando, como `channelId` de
// derivación de channelCrypto.js#encrypt(), el string sintético
// `onboarding:${session._id}` — el WhatsAppChannel real todavía no existe
// en este punto del flujo, así que no hay un channelId real para derivar
// la subclave. Blueprint §1.1.
const cipherFieldSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    keyVersion: { type: Number, required: true },
  },
  { _id: false }
);

const channelOnboardingSessionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    provider: { type: String, enum: PROVIDERS, required: true, default: 'gupshup' },
    status: { type: String, enum: STATUSES, required: true, default: 'initiated' },

    // Token opaco correlacionador — mismo rol que el `state` de
    // metaOauth.service.js, pero persistido en Mongo (no en Redis) porque
    // esta sesión SÍ necesita sobrevivir como historial (Decisión 2).
    // Default autogenerado para que crear una sesión no dependa de que el
    // caller invente su propio token único. `unique` se declara más abajo
    // vía schema.index() (no acá inline) para no duplicar la definición del
    // índice — Mongoose advierte si el mismo índice queda declarado dos veces.
    state: {
      type: String,
      required: true,
      default: () => crypto.randomBytes(24).toString('hex'),
    },

    // Se puebla recién cuando el WhatsAppChannel real existe (Decisión 7)
    // — ausente (undefined) durante todo el tramo initiated →
    // gupshup_registering. A PROPÓSITO sin `default: null`: un índice
    // sparse en Mongo solo excluye documentos donde el campo está AUSENTE,
    // no donde vale `null` — si este campo tuviera `default: null`,
    // Mongoose escribiría `channel: null` en cada documento, el índice
    // sparse dejaría de poder distinguirlos, y 2 sesiones cualesquiera sin
    // channel asignado chocarían entre sí como si fuera un duplicado real.
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel' },

    // Nombre elegido por el usuario en el paso de init (PR-03, blueprint
    // maestro §19) — se persiste acá porque WhatsAppChannel todavía no
    // existe en ese momento; pasa a WhatsAppChannel.displayName recién al
    // completar el onboarding.
    displayName: { type: String, trim: true, default: null },

    // Datos acumulados durante el flujo, antes de que puedan vivir en
    // WhatsAppChannel.
    meta: {
      wabaId: { type: String, default: null },
      phoneNumberId: { type: String, default: null },
      phoneNumber: { type: String, default: null }, // E.164, normalizado al llegar
      metaBusinessId: { type: String, default: null }, // Business Manager ID elegido en el popup — NO confundir con tenantId
      accessTokenCipher: { type: cipherFieldSchema, default: null },
    },

    gupshup: {
      appId: { type: String, default: null }, // -> WhatsAppChannel.providerAppId al completar
      webhookReference: { type: String, default: null }, // -> WhatsAppChannel.webhookReference al completar
      // PR-05 (blueprint maestro §55, redefinido esta sesión — ver
      // docs/integrations/gupshup-registration-contract.md §9): link real
      // de GET /partner/app/{appId}/onboarding/embed/link, que el usuario
      // completa del lado de Gupshup para terminar de asociar la WABA a
      // este appId. Válido 5 días (documentado por Gupshup) — de ahí
      // embedSignupUrlGeneratedAt, para saber si conviene pedir uno nuevo
      // antes de que Gupshup rechace un link vencido.
      embedSignupUrl: { type: String, default: null },
      embedSignupUrlGeneratedAt: { type: Date, default: null },
    },

    error: {
      step: { type: String, default: null }, // 'meta_auth' | 'gupshup_registration' | otro punto de falla
      message: { type: String, default: null },
    },

    // Ventana esperada para que el usuario complete el popup de Meta tras
    // init(). NO es un índice TTL (ver nota arriba) — es un dato que un
    // chequeo perezoso usa para decidir si transicionar a 'expired'.
    expiresAt: { type: Date, required: true, default: () => new Date(Date.now() + EXPIRACION_MS) },
  },
  { timestamps: true }
);

// Correlación del callback de Meta contra su sesión.
channelOnboardingSessionSchema.index({ state: 1 }, { unique: true });
// Listar sesiones activas de un tenant.
channelOnboardingSessionSchema.index({ tenantId: 1, status: 1 });
// 1:1 con el WhatsAppChannel que genera, mientras dura el onboarding
// (Decisión 7) — sparse porque `channel` es null durante todo el tramo
// previo a completed, y null no debe contar para la restricción unique.
channelOnboardingSessionSchema.index({ channel: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ChannelOnboardingSession', channelOnboardingSessionSchema);
module.exports.STATUSES = STATUSES;
module.exports.PROVIDERS = PROVIDERS;
