const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema(
  {
    // Módulo al que pertenece (users, leads, businesses, etc.)
    module: {
      type: String,
      required: [true, 'El módulo es requerido'],
      trim: true,
    },
    // Acción permitida (read, create, update, delete, etc.)
    action: {
      type: String,
      required: [true, 'La acción es requerida'],
      trim: true,
    },
    // Clave compuesta "module:action" para uso en RBAC
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Índice para búsqueda rápida por módulo
permissionSchema.index({ module: 1 });

const Permission = mongoose.model('Permission', permissionSchema);

module.exports = Permission;
