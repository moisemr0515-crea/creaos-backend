const { NODE_ENV, JWT_REFRESH_EXPIRES_IN } = require('../../config/env');

const REFRESH_COOKIE_NAME = NODE_ENV === 'production'
  ? '__Secure-crea_refresh'
  : 'crea_refresh';

const parseDurationMs = (value) => {
  const match = String(value || '').trim().match(/^(\d+)([smhd])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const units = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * units[match[2].toLowerCase()];
};

const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: NODE_ENV === 'production',
  sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/api/v1/auth',
  maxAge: parseDurationMs(JWT_REFRESH_EXPIRES_IN),
  // La web y el APK consumen hoy un backend cross-site. CHIPS evita que la
  // cookie se comparta entre sitios superiores en navegadores compatibles.
  partitioned: NODE_ENV === 'production',
});

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      return [key, decodeURIComponent(rawValue)];
    } catch {
      return [key, rawValue];
    }
  }).filter(([key]) => key)
);

const getRefreshTokenFromRequest = (req) => parseCookies(req.headers?.cookie)[REFRESH_COOKIE_NAME] || null;

const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
};

const clearRefreshCookie = (res) => {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
};

module.exports = {
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
  getRefreshTokenFromRequest,
  setRefreshCookie,
  clearRefreshCookie,
};
