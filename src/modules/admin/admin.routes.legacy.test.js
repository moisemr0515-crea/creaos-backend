const router = require('./admin.routes');

describe('rutas admin activas', () => {
  test('no monta el listado global de conexiones WhatsApp simuladas', () => {
    const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
    expect(paths).not.toContain('/whatsapp/connections');
  });
});
