jest.mock('../../utils/firebase', () => ({
  isConfigured: jest.fn(),
  getMessaging: jest.fn(),
}));

const mongoose = require('mongoose');
const PushToken = require('./push.model');
const firebase = require('../../utils/firebase');
const pushService = require('./push.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_push_worker';

describe('push.service — token estable y envío FCM', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await PushToken.init();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await PushToken.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  test('rotación FCM reemplaza el token del mismo dispositivo sin duplicarlo', async () => {
    const user = new mongoose.Types.ObjectId();
    const business = new mongoose.Types.ObjectId();
    await pushService.registrarToken(user, business, { token: 'token-old', platform: 'android', deviceId: 'device-1' });
    await pushService.registrarToken(user, business, { token: 'token-new', platform: 'android', deviceId: 'device-1' });

    const tokens = await PushToken.find({ user });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('token-new');
    expect(tokens[0].business.toString()).toBe(business.toString());
  });

  test('worker env configurado envía una vez y serializa data para FCM', async () => {
    const user = new mongoose.Types.ObjectId();
    const business = new mongoose.Types.ObjectId();
    await pushService.registrarToken(user, business, { token: 'token-1', platform: 'android', deviceId: 'device-1' });
    firebase.isConfigured.mockReturnValue(true);
    const sendEachForMulticast = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
    firebase.getMessaging.mockReturnValue({ sendEachForMulticast });

    const result = await pushService.sendToUser(user, {
      title: 'Nuevo mensaje',
      body: 'Hola',
      data: { leadId: new mongoose.Types.ObjectId(), unread: 1 },
    });

    expect(result).toEqual({ sent: 1, failed: 0, tokens: 1 });
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toEqual(['token-1']);
    expect(sendEachForMulticast.mock.calls[0][0].data.unread).toBe('1');
  });

  test('sin credenciales del worker omite push de forma explícita', async () => {
    firebase.isConfigured.mockReturnValue(false);
    await expect(pushService.sendToUser(new mongoose.Types.ObjectId(), {
      title: 'Nuevo mensaje', body: 'Hola',
    })).resolves.toEqual({ sent: 0, failed: 0, tokens: 0 });
    expect(firebase.getMessaging).not.toHaveBeenCalled();
  });
});
