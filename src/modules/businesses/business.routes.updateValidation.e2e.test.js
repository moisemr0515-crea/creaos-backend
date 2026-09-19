// Regresión del diagnóstico 19/sep/2026: website:"" y whatsappNumber:""
// (lo que manda SIEMPRE business.tsx#saveAll() cuando esos campos no están
// cargados — el caso normal de un negocio nuevo) tiraban 422 en TODO el PUT
// de /businesses/current, no solo en ese campo — validate.middleware.js
// corta la request completa ante cualquier error, así que agentName/
// currency/averageTicket/aiInstructions/redes sociales nunca llegaban a
// actualizarNegocio(). Fix: {checkFalsy:true} en ambos validadores. Este
// test pega contra la app real (supertest) para probar la ruta+validadores
// tal cual corren en producción, no solo el controller aislado.
jest.mock('../../middleware/auth.middleware', () => ({
  authenticate: (req, _res, next) => {
    req.user = { _id: 'user-1', role: { slug: 'owner', permissions: ['businesses:update'] } };
    next();
  },
}));
jest.mock('../../middleware/tenant.middleware', () => ({
  injectTenant: (req, _res, next) => {
    req.businessId = 'business-1';
    next();
  },
}));
jest.mock('./business.service');

const request = require('supertest');
const app = require('../../app');
const service = require('./business.service');

describe('PUT /api/v1/businesses/current — website/whatsappNumber vacíos', () => {
  beforeEach(() => jest.clearAllMocks());

  test('website:"" y whatsappNumber:"" ya NO tiran abajo el PUT completo', async () => {
    service.actualizarNegocio.mockResolvedValue({ _id: 'business-1', agentName: 'Marina' });

    const res = await request(app)
      .put('/api/v1/businesses/current')
      .send({
        agentName: 'Marina',
        currency: 'MXN',
        averageTicket: 150,
        aiInstructions: 'Sé amable y directo',
        website: '',
        whatsappNumber: '',
        facebookUrl: '',
        instagramUrl: '',
        tiktokUrl: '',
      });

    expect(res.status).toBe(200);
    expect(service.actualizarNegocio).toHaveBeenCalledWith(
      'business-1',
      expect.objectContaining({ agentName: 'Marina', currency: 'MXN', averageTicket: 150, aiInstructions: 'Sé amable y directo' })
    );
  });

  test('website con un valor real (no vacío) sigue llegando al servicio', async () => {
    service.actualizarNegocio.mockResolvedValue({ _id: 'business-1', website: 'https://negocio.com' });

    const res = await request(app)
      .put('/api/v1/businesses/current')
      .send({ website: 'https://negocio.com' });

    expect(res.status).toBe(200);
    expect(service.actualizarNegocio).toHaveBeenCalledWith('business-1', expect.objectContaining({ website: 'https://negocio.com' }));
  });

  test('website inválido de verdad (no vacío, mal formado) SIGUE rechazando con 422', async () => {
    const res = await request(app)
      .put('/api/v1/businesses/current')
      .send({ website: 'no-es-una-url' });

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ campo: 'website' })]));
    expect(service.actualizarNegocio).not.toHaveBeenCalled();
  });

  // Frente 2 (19/sep/2026): la validación de FORMATO de whatsappNumber ya no
  // vive en esta ruta (se movió a Business.model.js#esWhatsappValido, mismo
  // criterio que facebookUrl/instagramUrl/tiktokUrl) — este test mockea
  // business.service.js entero, así que no puede probar una validación que
  // ahora corre DENTRO de actualizarNegocio() vía Mongoose. Ver
  // business.service.whatsappValidation.test.js (Mongo real) para el
  // reemplazo real de este caso: sanitiza espacios/guiones acá, pero un
  // valor mal formado (ej. "abc") ya no lo rechaza esta ruta — lo rechaza el
  // modelo, un nivel más abajo.
  test('whatsappNumber con espacios/guiones llega sanitizado al servicio (customSanitizer, sin la validación de formato)', async () => {
    service.actualizarNegocio.mockResolvedValue({ _id: 'business-1', whatsappNumber: '+51987654321' });

    const res = await request(app)
      .put('/api/v1/businesses/current')
      .send({ whatsappNumber: '+51 987-654-321' });

    expect(res.status).toBe(200);
    expect(service.actualizarNegocio).toHaveBeenCalledWith('business-1', expect.objectContaining({ whatsappNumber: '+51987654321' }));
  });

  test('whatsappNumber con un valor real válido sigue llegando al servicio', async () => {
    service.actualizarNegocio.mockResolvedValue({ _id: 'business-1', whatsappNumber: '+51987654321' });

    const res = await request(app)
      .put('/api/v1/businesses/current')
      .send({ whatsappNumber: '+51 987 654 321' });

    expect(res.status).toBe(200);
    expect(service.actualizarNegocio).toHaveBeenCalledWith('business-1', expect.objectContaining({ whatsappNumber: '+51987654321' }));
  });
});
