const Notification = require('./notification.model');
const { AppError } = require('../../middleware/error.middleware');

const createNotification = async ({ business, user = null, type = 'info', category = 'system', title, message, meta = {} }) => {
  return Notification.create({ business, user, type, category, title, message, meta });
};

const createNotificationOnce = async ({ deduplicationKey, ...data }) => {
  if (!deduplicationKey) {
    return { notification: await createNotification(data), created: true };
  }

  const filter = {
    business: data.business,
    user: data.user ?? null,
    deduplicationKey,
  };
  const existing = await Notification.findOne(filter);
  if (existing) return { notification: existing, created: false };

  try {
    const notification = await Notification.create({ ...data, deduplicationKey });
    return { notification, created: true };
  } catch (err) {
    // La consulta previa evita el caso normal; el índice único resuelve la
    // carrera si dos workers intentan crear el mismo evento a la vez.
    if (err?.code === 11000) {
      const notification = await Notification.findOne(filter);
      if (notification) return { notification, created: false };
    }
    throw err;
  }
};

const buildRecipientFilter = (userId, businessId, category) => {
  const filter = { business: businessId, $or: [{ user: userId }, { user: null }] };
  if (category?.length) filter.category = { $in: category };
  return filter;
};

const getNotifications = async (userId, businessId, { page = 1, limit = 20, unreadOnly = false, category } = {}) => {
  const skip   = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const recipientFilter = buildRecipientFilter(userId, businessId, category);
  const filter = { ...recipientFilter };
  if (unreadOnly) filter.isRead = false;
  // Solo filtra si vino category (array no vacío) — sin este param, el
  // filtro queda igual que antes de este cambio, no rompe la campanita
  // existente. $in acepta 1 o varios valores por igual.

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...recipientFilter, isRead: false }),
  ]);

  return { items, total, unreadCount, page: parseInt(page, 10), limit: parseInt(limit, 10) };
};

const markAsRead = async (notificationId, userId, businessId) => {
  const notif = await Notification.findOne({
    _id: notificationId,
    business: businessId,
    $or: [{ user: userId }, { user: null }],
  });
  if (!notif) throw new AppError('Notificación no encontrada', 404);

  if (!notif.isRead) {
    notif.isRead = true;
    notif.readAt = new Date();
    await notif.save();
  }
  return notif;
};

const markAllAsRead = async (userId, businessId) => {
  const result = await Notification.updateMany(
    { business: businessId, $or: [{ user: userId }, { user: null }], isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return { updated: result.modifiedCount };
};

const getUnreadCount = async (userId, businessId) => {
  return Notification.countDocuments({
    business: businessId,
    $or: [{ user: userId }, { user: null }],
    isRead: false,
  });
};

const deleteNotification = async (notificationId, userId, businessId) => {
  const notif = await Notification.findOneAndDelete({
    _id: notificationId,
    business: businessId,
    $or: [{ user: userId }, { user: null }],
  });
  if (!notif) throw new AppError('Notificación no encontrada', 404);
  return notif;
};

module.exports = {
  createNotification,
  createNotificationOnce,
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  deleteNotification,
};
