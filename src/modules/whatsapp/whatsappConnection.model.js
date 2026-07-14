const mongoose = require('mongoose');

// Esqueleto para múltiples conexiones de WhatsApp Business por negocio (una por tenant).
// v1.1: 100% simulado (isSimulated: true) — el envío/recepción real de mensajes sigue
// yendo por el número compartido de Gupshup (GUPSHUP_PHONE_NUMBER), sin tocar.
// v1.2 (pendiente de aprobación ISV/Partner, ticket #264467): aquí se conectará la
// integración real vía Meta Embedded Signup + Gupshup Partner API.
const whatsappConnectionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    phoneNumber: { type: String, required: true, trim: true },
    // ID de WhatsApp Business Account — vacío hasta que exista la integración real
    wabaId: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'connecting', 'verifying', 'connected', 'disconnected', 'error'],
      default: 'pending',
    },
    connectedAt: { type: Date, default: null },
    isSimulated: { type: Boolean, default: true },
  },
  { timestamps: true }
);

whatsappConnectionSchema.index({ business: 1, status: 1 });

module.exports = mongoose.model('WhatsAppConnection', whatsappConnectionSchema);
