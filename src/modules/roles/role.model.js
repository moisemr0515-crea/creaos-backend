const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'El nombre del rol es requerido'],
      trim: true,
    },
    // Identificador único del rol (owner, admin, sales, etc.)
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Lista de permisos en formato "module:action"
    permissions: [
      {
        type: String,
        trim: true,
      },
    ],
    // Los roles del sistema (true) no se pueden eliminar ni modificar desde UI
    isSystem: {
      type: Boolean,
      default: false,
    },
    // Null = rol del sistema (disponible para todos los negocios)
    // ObjectId = rol personalizado de un negocio específico
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Un slug debe ser único dentro del mismo negocio (o entre roles del sistema)
roleSchema.index({ slug: 1, business: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema);

module.exports = Role;
