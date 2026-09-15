jest.mock('./auth.service', () => ({
  registrar: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  refreshAccessToken: jest.fn(),
  forgotPassword: jest.fn(),
  resetPassword: jest.fn(),
  verifyEmail: jest.fn(),
}));

const request = require('supertest');
const app = require('../../app');
const authService = require('./auth.service');
const { REFRESH_COOKIE_NAME } = require('./authCookie');

describe('flujo crítico HTTP de sesión', () => {
  beforeEach(() => jest.clearAllMocks());

  test('login -> refresh -> logout mantiene el refresh solo en cookie HttpOnly', async () => {
    authService.login.mockResolvedValue({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      usuario: { _id: 'user-1', email: 'owner@example.com' },
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'Password1' })
      .expect(200);

    expect(login.body.data).toMatchObject({ accessToken: 'access-1' });
    expect(login.body.data.refreshToken).toBeUndefined();
    const loginCookie = login.headers['set-cookie'][0];
    expect(loginCookie).toContain(`${REFRESH_COOKIE_NAME}=refresh-1`);
    expect(loginCookie).toContain('HttpOnly');

    authService.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', loginCookie.split(';')[0])
      .expect(200);

    expect(authService.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'refresh-1' });
    expect(refresh.body.data).toEqual({ accessToken: 'access-2' });
    expect(refresh.headers['set-cookie'][0]).toContain(`${REFRESH_COOKIE_NAME}=refresh-2`);

    authService.logout.mockResolvedValue();
    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=refresh-2`)
      .expect(200);

    expect(authService.logout).toHaveBeenCalledWith({ refreshToken: 'refresh-2' });
    expect(logout.headers['set-cookie'][0]).toContain(`${REFRESH_COOKIE_NAME}=`);
  });

  test('refresh sin cookie falla cerrado y limpia cualquier cookie residual', async () => {
    const error = new Error('Refresh token requerido');
    error.statusCode = 401;
    authService.refreshAccessToken.mockRejectedValue(error);

    const response = await request(app).post('/api/v1/auth/refresh').expect(401);

    expect(authService.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: null });
    expect(response.headers['set-cookie'][0]).toContain(`${REFRESH_COOKIE_NAME}=`);
    expect(response.body.success).toBe(false);
  });
});
