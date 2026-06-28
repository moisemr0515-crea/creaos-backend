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
    meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ business: 1, user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ business: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES      = NOTIFICATION_TYPES;
module.exports.NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES;
