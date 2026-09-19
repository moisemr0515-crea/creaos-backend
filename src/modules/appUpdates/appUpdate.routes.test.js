// Verifica el WIRING de las rutas (quién queda detrás de auth y quién no),
// no el comportamiento de negocio — eso ya está cubierto en
// appUpdate.controller.test.js y appUpdate.service.test.js. Mismo estilo
// de inspección de router.stack que admin.routes.legacy.test.js.
const router = require('./appUpdate.routes');

const capaDe = (routePath, method) =>
  router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]);

describe('appUpdate.routes — wiring de autenticación', () => {
  test('POST /check queda público: un solo handler, sin authenticate ni checkRole', () => {
    const capa = capaDe('/check', 'post');
    expect(capa.route.stack).toHaveLength(1);
    expect(capa.route.stack[0].name).toBe('check');
  });

  test('GET /download/:filename queda público: un solo handler', () => {
    const capa = capaDe('/download/:filename', 'get');
    expect(capa.route.stack).toHaveLength(1);
    expect(capa.route.stack[0].name).toBe('download');
  });

  test('POST /publish exige authenticate() antes del controller', () => {
    const capa = capaDe('/publish', 'post');
    const nombres = capa.route.stack.map((layer) => layer.name);
    expect(nombres).toContain('authenticate');
    expect(nombres[nombres.length - 1]).toBe('publish');
  });

  test('POST /publish tiene más de un middleware antes del controller (auth + rol + upload)', () => {
    const capa = capaDe('/publish', 'post');
    expect(capa.route.stack.length).toBeGreaterThan(2);
  });
});
