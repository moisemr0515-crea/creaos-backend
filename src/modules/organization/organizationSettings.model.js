const mongoose = require('mongoose');

// Configuración global de la plataforma CREA OS (identidad legal y de marca).
// Singleton: un único documento en toda la colección, gestionado desde
// GET/PATCH /api/v1/admin/organization/settings (solo Super Admin).
const organizationSettingsSchema = new mongoose.Schema(
  {
    legalName: { type: String, required: true, trim: true, maxlength: 200 },
    ruc: {
      type: String,
      trim: true,
      match: [/^\d{11}$/, 'El RUC debe tener exactamente 11 dígitos'],
    },
    brandName: { type: String, required: true, trim: true, maxlength: 100 },
    supportEmail: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    domain: { type: String, trim: true, lowercase: true, maxlength: 255 },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('OrganizationSettings', organizationSettingsSchema);
