// Test real (Jest, controller aislado con service/businessAssetAccess
// mockeados) de GET /businesses/current/assets/:campo/access — P0 de
// seguridad (auditoría Business Brain, 19/sep/2026, Bloque 1). El punto
// central a probar: el negocio que se consulta viene SIEMPRE de
// req.businessId (injectTenant, server-side) — la ruta no acepta ningún
// businessId del cliente, así que no hay vector de "pedir el asset de
// otro tenant" a través de este endpoint por diseño, no por un chequeo
// que se pueda olvidar.
jest.mock('./business.service');
jest.mock('./businessAssetAccess.service');

const service = require('./business.service');
const businessAssetAccess = require('./businessAssetAccess.service');
const { getAssetAccess } = require('./business.controller');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('business.controller#getAssetAccess()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('campo inválido (no está en la whitelist): 400, nunca llama al negocio ni a Cloudinary', async () => {
    const req = { businessId: 'biz-1', params: { campo: 'algo-inventado' }, query: {} };
    const next = jest.fn();

    await getAssetAccess(req, response(), next);

    expect(service.obtenerNegocioActual).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('usa SIEMPRE req.businessId (injectTenant) — nunca un id del cliente, la ruta no tiene ese param', async () => {
    service.obtenerNegocioActual.mockResolvedValue({ _id: 'biz-1', logo: 'x' });
    businessAssetAccess.obtenerUrlDeAcceso.mockReturnValue('https://signed.example/logo');
    const req = { businessId: 'biz-1', params: { campo: 'logo' }, query: {} };

    await getAssetAccess(req, response(), jest.fn());

    expect(service.obtenerNegocioActual).toHaveBeenCalledWith('biz-1');
  });

  test('campo "logo": pide la URL con propósito "display" (TTL corto, dashboard)', async () => {
    service.obtenerNegocioActual.mockResolvedValue({ _id: 'biz-1' });
    businessAssetAccess.obtenerUrlDeAcceso.mockReturnValue('https://signed.example/logo');
    const req = { businessId: 'biz-1', params: { campo: 'logo' }, query: {} };
    const res = response();

    await getAssetAccess(req, res, jest.fn());

    expect(businessAssetAccess.obtenerUrlDeAcceso).toHaveBeenCalledWith(expect.objectContaining({ _id: 'biz-1' }), 'logo', 'display');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { url: 'https://signed.example/logo' } }));
  });

  test('campo "photos": usa obtenerUrlDeAccesoFoto() con el índice de ?index=', async () => {
    service.obtenerNegocioActual.mockResolvedValue({ _id: 'biz-1' });
    businessAssetAccess.obtenerUrlDeAccesoFoto.mockReturnValue('https://signed.example/foto-1');
    const req = { businessId: 'biz-1', params: { campo: 'photos' }, query: { index: '1' } };

    await getAssetAccess(req, response(), jest.fn());

    expect(businessAssetAccess.obtenerUrlDeAccesoFoto).toHaveBeenCalledWith(expect.objectContaining({ _id: 'biz-1' }), 1, 'display');
  });

  test('sin ese asset cargado (obtenerUrlDeAcceso devuelve null): 404, no 500', async () => {
    service.obtenerNegocioActual.mockResolvedValue({ _id: 'biz-1' });
    businessAssetAccess.obtenerUrlDeAcceso.mockReturnValue(null);
    const req = { businessId: 'biz-1', params: { campo: 'brochure' }, query: {} };
    const next = jest.fn();

    await getAssetAccess(req, response(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
