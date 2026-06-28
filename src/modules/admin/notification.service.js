const Notification = require('./notification.model');
const { AppError } = require('../../middleware/error.middleware');

const createNotification = async ({ business, user = null, type = 'info', category = 'system', title, message, meta = {} }) => {
  return Notification.create({ business, user, type, category, title, message, meta });
};

const getNotifications = async (userId, businessId, { page = 1, limit = 20, unreadOnly = false } = {}) => {
  const skip   = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const filter = {
    business: businessId,
    $or: [{ user: userId }, { user: null }],
  };
  if (unreadOnly) filter.isRead = false;

  const [items, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    Notification.countDocuments(filter),
  ]);

  return { items, total, page: parseInt(page, 10), limit: parseInt(limit, 10) };
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
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  deleteNotification,
};
