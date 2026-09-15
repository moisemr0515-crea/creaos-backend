jest.mock('../../config/env', () => ({ NODE_ENV: 'production', JWT_REFRESH_EXPIRES_IN: '7d' }));
jest.mock('./auth.service', () => ({
  login: jest.fn(),
  logout: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

const authService = require('./auth.service');
const controller = require('./auth.controller');
const { REFRESH_COOKIE_NAME } = require('./authCookie');

const response = () => {
  const res = {};
  res.cookie = jest.fn();
  res.clearCookie = jest.fn();
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('auth.controller — refresh token HttpOnly', () => {
  beforeEach(() => jest.clearAllMocks());

  test('login guarda refresh en cookie segura y nunca lo expone en JSON', async () => {
    authService.login.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh-secret', usuario: { _id: 'u1' } });
    const res = response();

    await controller.login({ body: { email: 'a@b.com', password: 'Password1' } }, res, jest.fn());

    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'refresh-secret', expect.objectContaining({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/api/v1/auth',
    }));
    expect(res.json.mock.calls[0][0].data).toEqual({ accessToken: 'access', usuario: { _id: 'u1' } });
  });

  test('refresh lee la cookie, rota la cookie y devuelve solo el access token', async () => {
    authService.refreshAccessToken.mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    const res = response();

    await controller.refresh({ headers: { cookie: `${REFRESH_COOKIE_NAME}=old-refresh` } }, res, jest.fn());

    expect(authService.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'new-refresh', expect.any(Object));
    expect(res.json.mock.calls[0][0].data).toEqual({ accessToken: 'new-access' });
  });

  test('logout revoca el token de la cookie y la elimina', async () => {
    authService.logout.mockResolvedValue();
    const res = response();

    await controller.logout({ headers: { cookie: `${REFRESH_COOKIE_NAME}=refresh` } }, res, jest.fn());

    expect(authService.logout).toHaveBeenCalledWith({ refreshToken: 'refresh' });
    expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, expect.objectContaining({ path: '/api/v1/auth' }));
  });

  test('refresh ausente o inválido limpia cookie y no crea sesión', async () => {
    authService.refreshAccessToken.mockRejectedValue(new Error('invalid refresh'));
    const res = response();
    const next = jest.fn();

    await controller.refresh({ headers: {} }, res, next);

    expect(authService.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: null });
    expect(res.clearCookie).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
