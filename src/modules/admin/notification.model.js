const mongoose = require('mongoose');

const NOTIFICATION_TYPES     = ['info', 'warning', 'error', 'success'];
const NOTIFICATION_CATEGORIES = ['lead', 'automation', 'subscription', 'system', 'ai'];

const notificationSchema = new mongoose.Schema(
  {
    business:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    type:      { type: String, enum: NOTIFICATION_TYPES,     default: 'info' },
    category:  { type: String, enum: NOTIFICATION_CATEGORIES, default: 'system' },
    title:     { type: String, required: true, maxlength: 200 },
    message:   { type: String, required: true, maxlength: 1000 },
    isRead:    { type: Boolean, default: false },
    readAt:    { type: Date, default: null },
    // Clave estable para eventos externos reintentables (por ejemplo un
    // InboundEvent de WhatsApp). Permite crear la notificación in-app una
    // sola vez y usar esa misma creación como compuerta del push, evitando
    // duplicados cuando BullMQ reentrega el job.
    deduplicationKey: { type: String, default: null, maxlength: 300 },
    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ business: 1, user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ business: 1, createdAt: -1 });
notificationSchema.index(
  { business: 1, user: 1, deduplicationKey: 1 },
  { unique: true, partialFilterExpression: { deduplicationKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES      = NOTIFICATION_TYPES;
module.exports.NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES;
