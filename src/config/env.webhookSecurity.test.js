const BASE_ENV = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://example.invalid/test',
  REDIS_URL: 'redis://example.invalid:6379',
  JWT_SECRET: 'test-jwt-secret-with-at-least-32-characters',
  JWT_REFRESH_SECRET: 'different-refresh-secret-with-at-least-32-chars',
  FRONTEND_URL: 'https://creaosapp.test',
  OPENAI_API_KEY: 'test-openai-key',
  RESEND_API_KEY: 'test-resend-key',
  META_APP_ID: '',
  META_APP_SECRET: '',
  WHATSAPP_TOKEN: '',
  WHATSAPP_PHONE_ID: '',
  WHATSAPP_APP_SECRET: '',
  GUPSHUP_API_KEY: '',
  GUPSHUP_APP_NAME: '',
  GUPSHUP_PHONE_NUMBER: '',
  GUPSHUP_WEBHOOK_TOKEN: '',
  GUPSHUP_PARTNER_EMAIL: '',
  GUPSHUP_PARTNER_SECRET: '',
  GUPSHUP_ONBOARDING_WEBHOOK_TOKEN: '',
  BACKEND_PUBLIC_URL: '',
  CHANNEL_CREDENTIALS_KEY: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_PUBLIC_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  MP_ACCESS_TOKEN: '',
  MP_PUBLIC_KEY: '',
  MP_WEBHOOK_SECRET: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  FIREBASE_PROJECT_ID: '',
  FIREBASE_CLIENT_EMAIL: '',
  FIREBASE_PRIVATE_KEY: '',
};

const loadEnv = (overrides = {}) => {
  jest.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return require('./env');
};

describe('validateEnv — seguridad de webhooks en producción', () => {
  const originalEnv = process.env;
  afterAll(() => { process.env = originalEnv; });

  test('NODE_ENV ausente produce error de arranque', () => {
    const env = loadEnv({ NODE_ENV: undefined });
    expect(() => env.validateEnv()).toThrow(/NODE_ENV/);
  });

  test.each([
    [{ META_APP_ID: 'meta-app' }, /META_APP_SECRET/],
    [{ WHATSAPP_TOKEN: 'wa-token' }, /WHATSAPP_APP_SECRET o META_APP_SECRET/],
    [{ GUPSHUP_API_KEY: 'gs-key' }, /GUPSHUP_WEBHOOK_TOKEN/],
    [{ STRIPE_SECRET_KEY: 'sk_test' }, /STRIPE_WEBHOOK_SECRET/],
    [{ MP_ACCESS_TOKEN: 'mp-token' }, /MP_WEBHOOK_SECRET/],
  ])('integración configurada sin secreto crítico falla al arrancar: %j', (configured, expected) => {
    const env = loadEnv(configured);
    expect(() => env.validateEnv()).toThrow(expected);
  });

  test('integraciones no configuradas pueden permanecer deshabilitadas', () => {
    expect(() => loadEnv().validateEnv()).not.toThrow();
  });

  test('BACKEND_PUBLIC_URL por sí sola no habilita onboarding de Gupshup', () => {
    expect(() => loadEnv({ BACKEND_PUBLIC_URL: 'https://api.creaosapp.test' }).validateEnv()).not.toThrow();
  });

  test('API de producción falla temprano si falta un servicio core', () => {
    const env = loadEnv({ OPENAI_API_KEY: undefined });
    expect(() => env.validateEnv()).toThrow(/OPENAI_API_KEY/);
  });

  test('worker exige solo sus dependencias críticas y no secretos JWT', () => {
    const env = loadEnv({ JWT_SECRET: undefined, JWT_REFRESH_SECRET: undefined, FRONTEND_URL: undefined, RESEND_API_KEY: undefined });
    expect(() => env.validateEnv({ runtime: 'worker' })).not.toThrow();
  });

  test('configuración parcial de una integración opcional falla al arrancar', () => {
    const env = loadEnv({ FIREBASE_PROJECT_ID: 'configured' });
    expect(() => env.validateEnv()).toThrow(/FIREBASE_CLIENT_EMAIL/);
  });

  test('JWT cortos o iguales fallan en la API de producción', () => {
    const env = loadEnv({ JWT_SECRET: 'short', JWT_REFRESH_SECRET: 'short' });
    expect(() => env.validateEnv()).toThrow(/al menos 32 caracteres/);
  });

  test('development conserva el flujo local controlado', () => {
    const env = loadEnv({ NODE_ENV: 'development', META_APP_ID: 'local-meta' });
    expect(() => env.validateEnv()).not.toThrow();
  });
});
