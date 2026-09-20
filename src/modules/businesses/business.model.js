const mongoose = require('mongoose');
const slugify = require('slugify');
const { TRIAL_DAYS } = require('../../config/constants');

// Identidad del negocio — redes sociales (12/sep/2026): validación básica de
// URL para facebookUrl/instagramUrl/tiktokUrl, sin exigir que sea
// exactamente del dominio de esa red (un negocio puede tener una página de
// Facebook con dominio propio via redirect, o simplemente no queremos ser
// más estrictos de lo necesario) — solo que sea una URL bien formada
// http(s). `website` (arriba, ya existente) no tiene esta validación; se
// deja igual a propósito, fuera del alcance de este cambio.
const esUrlValida = (valor) => {
  if (!valor) return true; // opcional — string vacío/null nunca es error de formato
  try {
    const url = new URL(valor);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

// Frente 2 (diagnóstico "desincronización de plan Starter"/multipaís,
// 19/sep/2026): este regex vivía SOLO en business.routes.js (express-
// validator), no acá — a diferencia de esUrlValida (arriba), que sí protege
// a nivel de schema. Cualquier escritura de whatsappNumber que no pasara por
// esa ruta puntual (un script, una migración, un endpoint admin futuro)
// quedaba sin ninguna validación. Se mueve acá, mismo criterio que
// esUrlValida — NO se aplica a Lead.phone/Business.phone/User.phone
// (decisión de producto confirmada 19/sep: esos campos tienen datos reales
// de producción en formato libre, forzar su schema ahora podría romper la
// edición de leads viejos — whatsappNumber no tiene ese volumen histórico).
const esWhatsappValido = (valor) => {
  if (!valor) return true; // opcional — string vacío/null nunca es error de formato
  return /^\+?[1-9]\d{7,14}$/.test(valor);
};

const businessSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'El nombre del negocio es requerido'],
      trim: true,
      minlength: [2, 'El nombre debe tener al menos 2 caracteres'],
      maxlength: [100, 'El nombre no puede exceder 100 caracteres'],
    },
    // Nombre del AGENTE de IA (12/sep/2026) — deliberadamente separado de
    // `name` (arriba, el nombre del NEGOCIO): "somos de CREA OS" usa
    // `name`, "Soy Marina" usa este campo. Opcional y sin default forzado
    // acá — el fallback a "Alex" vive en ai.service.js#buildSystemPrompt(),
    // no en el schema, mismo criterio que aiPersonality (default seguro
    // aplicado en el builder del prompt para documentos viejos sin este
    // campo seteado, no en una escritura silenciosa del modelo).
    agentName: {
      type: String,
      trim: true,
      maxlength: [50, 'El nombre del agente no puede exceder 50 caracteres'],
      default: null,
    },
    // Identificador único URL-friendly generado desde el nombre
    slug: {
      type: String,
      unique: true,
      lowercase: true,
    },
    logo: {
      type: String,
      default: null,
    },
    // Hasta 2 fotos de producto (Cloudinary)
    photos: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 2,
        message: 'Máximo 2 fotos de producto',
      },
    },
    // P0 de seguridad (auditoría Business Brain, 19/sep/2026, Bloque 1) —
    // logo/photos/pdfUrl/presentationVideoUrl/brochureUrl de arriba/abajo
    // son URLs PÚBLICAS directas de Cloudinary (type:'upload'), accesibles
    // por cualquiera sin pasar por la API — confirmado y reproducido en la
    // Fase 1 del diagnóstico. Estos campos *Asset son la forma NUEVA
    // (publicId/resourceType, sin URL) que consume
    // businessAssetAccess.service.js para generar accesos firmados con
    // expiración real — coexisten con los campos viejos a propósito
    // (rollout en 3 pasos, ver docs/business-brain-audit/): Paso 1/2 los
    // llenan en cada upload NUEVO sin tocar los campos viejos; Paso 3
    // migra los documentos existentes (rename en Cloudinary a
    // type:'authenticated', sin re-subir el archivo) y recién ahí los
    // campos viejos quedan obsoletos. _id:false — son metadata interna,
    // no documentos propios con su propio ciclo de vida.
    logoAsset: {
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
      _id: false,
    },
    photoAssets: {
      type: [{ publicId: String, resourceType: String, _id: false }],
      default: [],
    },
    // PDF informativo del negocio, usado para entrenar a la IA de ventas
    pdfUrl: {
      type: String,
      default: null,
    },
    pdfAsset: {
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
      _id: false,
    },
    pdfExtractedText: {
      type: String,
      maxlength: 5000,
      default: null,
    },
    // Resumen del PDF (generado una sola vez al subirlo) — esto es lo que
    // realmente se inyecta en cada mensaje del prompt de la IA, para no
    // pagar tokens del texto completo en cada turno de la conversación
    pdfSummary: {
      type: String,
      maxlength: 800,
      default: null,
    },
    pdfUploadedAt: {
      type: Date,
      default: null,
    },
    // Archivos multimedia para ENVIAR al lead por WhatsApp (send_media,
    // auditoría de factibilidad 12/sep/2026) — DISTINTOS de pdfUrl/
    // pdfExtractedText/pdfSummary de arriba, que son el PDF de
    // CONOCIMIENTO del agente (texto extraído + resumen inyectado en el
    // prompt). Estos 2 no se procesan ni se leen: se guardan tal cual y se
    // reenvían como adjunto real cuando el lead lo pide. Límites de tamaño
    // (16MB video, 100MB documento) se validan en business.routes.js
    // (multer), no acá — son los límites reales de Meta/WhatsApp Business
    // API para media saliente, no un criterio propio.
    presentationVideoUrl: {
      type: String,
      default: null,
    },
    presentationVideoAsset: {
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
      _id: false,
    },
    brochureUrl: {
      type: String,
      default: null,
    },
    // Gupshup Partner API acepta filename como opcional para type:'document'
    // (confirmado contra su documentación), pero sin él WhatsApp muestra el
    // archivo sin nombre amigable — se guarda el nombre original subido.
    brochureFilename: {
      type: String,
      default: null,
    },
    brochureAsset: {
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
      _id: false,
    },
    industry: {
      type: String,
      trim: true,
      default: null,
    },
    // Default corregido a 'PE' (19/sep/2026, Frente 2 — diagnóstico
    // multipaís): 'MX' venía desde el primer commit de este modelo
    // (2b4a11e, 28/jun/2026) sin ningún ajuste, y ningún formulario del
    // frontend escribe este campo nunca — así que el valor real de TODO
    // negocio hasta hoy era 100% artefacto de este default, nunca una
    // elección de nadie (confirmado antes de correr la migración
    // puntual que corrige los documentos ya existentes, ver
    // scripts/migrate-business-country-pe.js). CREA OS es una empresa
    // peruana (Myrel Company S.A.C.) — 'PE' es el default correcto real,
    // no una preferencia arbitraria nueva.
    country: {
      type: String,
      trim: true,
      default: 'PE',
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'MXN',
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    website: {
      type: String,
      trim: true,
      default: null,
    },
    // Identidad del negocio — redes sociales (12/sep/2026): para que la IA
    // de ventas pueda compartirlas cuando el lead las pida. Todos
    // opcionales — un negocio existente sin estos campos sigue funcionando
    // igual (default null, sin required).
    facebookUrl: {
      type: String,
      trim: true,
      default: null,
      validate: { validator: esUrlValida, message: 'facebookUrl debe ser una URL válida (ej. https://facebook.com/tu-negocio)' },
    },
    instagramUrl: {
      type: String,
      trim: true,
      default: null,
      validate: { validator: esUrlValida, message: 'instagramUrl debe ser una URL válida (ej. https://instagram.com/tu-negocio)' },
    },
    tiktokUrl: {
      type: String,
      trim: true,
      default: null,
      validate: { validator: esUrlValida, message: 'tiktokUrl debe ser una URL válida (ej. https://tiktok.com/@tu-negocio)' },
    },
    // Onboarding: número de WhatsApp del negocio (distinto de `phone`, uso comercial)
    whatsappNumber: {
      type: String,
      trim: true,
      default: null,
      validate: { validator: esWhatsappValido, message: 'whatsappNumber debe tener formato internacional válido (ej. +51987654321)' },
    },
    // Onboarding: qué vende el negocio
    productDescription: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    // Onboarding: ticket promedio de venta (en la moneda de `currency`)
    averageTicket: {
      type: Number,
      min: 0,
      default: null,
    },
    // Onboarding: descripción del cliente ideal/objetivo
    targetCustomer: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    // Se marca true automáticamente cuando quedan llenos productDescription,
    // averageTicket, targetCustomer y whatsappNumber (ver actualizarNegocio en business.service.js)
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    // Instrucciones libres del dueño para el comportamiento de la IA de ventas
    aiInstructions: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },
    // Tono de la IA de ventas — toggle "Personalidad" de la sección IA
    // vendedora (crea-os-ignite, business.tsx). Cableado real (antes era
    // placeholder puro: viajaba a PUT /users/me, que solo persiste
    // name/phone/avatar y descartaba este campo en silencio — ver
    // ai.service.js#buildSystemPrompt() para el único punto de consumo).
    // Mismo patrón que aiInstructions: default seguro, nunca bloquea un
    // negocio que no lo configuró explícitamente.
    aiPersonality: {
      type: String,
      enum: ['cercano', 'formal', 'agresivo'],
      default: 'cercano',
    },
    // Toggle "Activar ventas automáticas con IA" — a nivel de negocio (NO de
    // usuario: un mismo usuario puede administrar varios negocios, y cada uno
    // necesita su propio estado independiente). Fail-closed: default false,
    // así que un negocio nuevo o uno preexistente sin este campo seteado en
    // Mongo se comporta como IA automática apagada hasta que el dueño la
    // active explícitamente. Reemplaza a User.global_ai_auto_enabled (que se
    // mantiene por ahora sin usarse, hasta que el frontend migre — ver PR).
    aiSalesEnabled: {
      type: Boolean,
      default: false,
    },
    // Paso 3 de la deprecación de business.plan/planStatus (12/sep/2026):
    // campos eliminados del schema. Subscription.planName es la única
    // fuente de verdad del plan de un negocio (ver Paso 1, use-plan.ts).
    // Los 4 consumidores muertos que quedaban (tenant.middleware.js,
    // user.service.js, auth.ts, profile.ts) ya fueron eliminados en el
    // Paso 2. Auditoría original: cero escrituras a estos campos en el
    // código, sin índice ni validación que dependa de su existencia —
    // confirmado de nuevo con grep exhaustivo antes de este cambio.
    // Los documentos existentes en Mongo que aún tienen `plan`/
    // `planStatus` guardados quedan como datos huérfanos (Mongoose los
    // sigue devolviendo en toObject()/toJSON() aunque no estén en el
    // schema, porque strict mode solo aplica a escritura); ver
    // scripts/unset-business-plan-fields.js para la limpieza opcional.
    trialEndsAt: {
      type: Date,
      default: () => {
        const fecha = new Date();
        fecha.setDate(fecha.getDate() + TRIAL_DAYS);
        return fecha;
      },
    },
    settings: {
      timezone: { type: String, default: 'America/Mexico_City' },
      language: { type: String, default: 'es' },
      notifications: {
        email: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: false },
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Genera slug automáticamente antes de guardar
businessSchema.pre('save', async function (next) {
  if (!this.isModified('name') && this.slug) return next();

  const baseSlug = slugify(this.name, { lower: true, strict: true });
  let slug = baseSlug;
  let counter = 1;

  // Asegura unicidad agregando sufijo numérico si es necesario
  while (await mongoose.model('Business').exists({ slug, _id: { $ne: this._id } })) {
    slug = `${baseSlug}-${counter++}`;
  }

  this.slug = slug;
  next();
});

const Business = mongoose.model('Business', businessSchema);

module.exports = Business;
