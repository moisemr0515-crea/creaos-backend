const mongoose = require('mongoose');
const slugify = require('slugify');
const { PLANS, PLAN_STATUS, TRIAL_DAYS } = require('../../config/constants');

const businessSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'El nombre del negocio es requerido'],
      trim: true,
      minlength: [2, 'El nombre debe tener al menos 2 caracteres'],
      maxlength: [100, 'El nombre no puede exceder 100 caracteres'],
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
    // PDF informativo del negocio, usado para entrenar a la IA de ventas
    pdfUrl: {
      type: String,
      default: null,
    },
    pdfExtractedText: {
      type: String,
      maxlength: 5000,
      default: null,
    },
    pdfUploadedAt: {
      type: Date,
      default: null,
    },
    industry: {
      type: String,
      trim: true,
      default: null,
    },
    country: {
      type: String,
      trim: true,
      default: 'MX',
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
    // Onboarding: número de WhatsApp del negocio (distinto de `phone`, uso comercial)
    whatsappNumber: {
      type: String,
      trim: true,
      default: null,
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
    plan: {
      type: String,
      enum: Object.values(PLANS),
      default: PLANS.TRIAL,
    },
    planStatus: {
      type: String,
      enum: Object.values(PLAN_STATUS),
      default: PLAN_STATUS.TRIAL,
    },
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
