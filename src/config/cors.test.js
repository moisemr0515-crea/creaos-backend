jest.mock('./env', () => ({
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://creaosapp.com',
  ALLOWED_ORIGINS: ['https://preview-123.vercel.app'],
  CAPACITOR_ORIGINS: ['https://localhost'],
}));

const { isAllowedOrigin } = require('./cors');

describe('CORS exacto', () => {
  test.each([
    'https://creaosapp.com',
    'https://preview-123.vercel.app',
    'https://localhost',
  ])('acepta origen configurado %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  test.each([
    'https://creaosapp.com.evil.test',
    'https://crea-os-ignite-attacker.vercel.app',
    'http://localhost:5173',
    'not-an-origin',
  ])('rechaza origen no configurado o parecido %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });
});
