const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'El email es requerido'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Formato de email inválido'],
    },
    // La contraseña nunca se devuelve en queries por defecto
    password: {
      type: String,
      required: [true, 'La contraseña es requerida'],
      minlength: [8, 'La contraseña debe tener al menos 8 caracteres'],
      select: false,
    },
    name: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
      minlength: [2, 'El nombre debe tener al menos 2 caracteres'],
      maxlength: [80, 'El nombre no puede exceder 80 caracteres'],
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    avatar: {
      type: String,
      default: null,
    },
    // Referencia al rol asignado (Owner, Admin, Sales, etc.)
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: [true, 'El rol es requerido'],
    },
    // Multi-tenant: todos los recursos se filtran por este campo
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: [true, 'El negocio es requerido'],
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    // Hash del token de verificación de email (el token plano se envía por email)
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
    // Hash del token de reset de contraseña
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    // JTIs (IDs) de refresh tokens activos — referencia; Redis es la fuente de verdad
    refreshTokenJtis: {
      type: [String],
      select: false,
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Índice compuesto para filtrar usuarios activos del negocio
userSchema.index({ business: 1, isActive: 1 });
// Nota: email ya tiene índice único declarado en el campo (unique: true)

const User = mongoose.model('User', userSchema);

module.exports = User;
