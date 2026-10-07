const mongoose = require('mongoose');
const Notification = require('./notification.model');
const notificationService = require('./notification.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_notifications_unified';

describe('notification.service — listado, unread y tenant isolation', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterEach(async () => {
    await Notification.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  test('lista y unreadCount salen del mismo conjunto persistido', async () => {
    const business = new mongoose.Types.ObjectId();
    const user = new mongoose.Types.ObjectId();
    await notificationService.createNotification({
      business,
      user,
      category: 'lead',
      title: 'Nuevo mensaje',
      message: 'Hola',
    });

    const result = await notificationService.getNotifications(user, business);
    expect(result.items).toHaveLength(1);
    expect(result.unreadCount).toBe(1);

    await notificationService.markAsRead(result.items[0]._id, user, business);
    const afterRead = await notificationService.getNotifications(user, business);
    expect(afterRead.items).toHaveLength(1);
    expect(afterRead.items[0].isRead).toBe(true);
    expect(afterRead.unreadCount).toBe(0);
  });

  test('no lista ni cuenta notificaciones de otro tenant o usuario', async () => {
    const businessA = new mongoose.Types.ObjectId();
    const businessB = new mongoose.Types.ObjectId();
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    await Promise.all([
      notificationService.createNotification({ business: businessA, user: userA, title: 'A', message: 'A' }),
      notificationService.createNotification({ business: businessA, user: userB, title: 'B user', message: 'B' }),
      notificationService.createNotification({ business: businessB, user: userA, title: 'B tenant', message: 'B' }),
      notificationService.createNotification({ business: businessA, user: null, title: 'Global A', message: 'A' }),
    ]);

    const result = await notificationService.getNotifications(userA, businessA);
    expect(result.items.map((item) => item.title).sort()).toEqual(['A', 'Global A']);
    expect(result.unreadCount).toBe(2);
    await expect(notificationService.markAsRead(
      (await Notification.findOne({ business: businessB }))._id,
      userA,
      businessA,
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  test('markAll y delete mantienen lista y contador sincronizados', async () => {
    const business = new mongoose.Types.ObjectId();
    const user = new mongoose.Types.ObjectId();
    const first = await notificationService.createNotification({ business, user, title: 'Uno', message: '1' });
    await notificationService.createNotification({ business, user, title: 'Dos', message: '2' });

    await notificationService.markAllAsRead(user, business);
    expect((await notificationService.getNotifications(user, business)).unreadCount).toBe(0);
    await notificationService.deleteNotification(first._id, user, business);
    expect((await notificationService.getNotifications(user, business)).items).toHaveLength(1);
  });
});
