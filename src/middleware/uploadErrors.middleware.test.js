// Test real (Jest, sin mocks de multer — usa la librería real) de
// uploadErrors.middleware.js#traducirErroresDeMulter() — hallazgo de
// "Archivos del negocio" (12/sep/2026): un MulterError no tiene
// .statusCode, así que error.middleware.js#errorHandler lo trataba
// como un 500 genérico con el mensaje en inglés de Multer ("File too
// large"), afectando por igual a logo/PDF informativo/video de
// presentación/brochure.
//
// 2 niveles de test:
//   1. Unitario — llama a traducirErroresDeMulter() directo con un
//      middlewareMulter FALSO que dispara cada tipo de error a mano.
//   2. HTTP real (supertest) — monta una app Express mínima con multer
//      REAL (misma librería, mismos 4 campos/labels que business.routes.js)
//      + el errorHandler REAL, y confirma que un archivo que excede el
//      límite responde 413 con el mensaje esperado, no 500. Usa límites
//      chicos (bytes, no MB) para que el test sea rápido y determinístico
//      — lo que se prueba es la TRADUCCIÓN del error, no los límites
//      reales en sí (esos ya están confirmados en business.routes.js:
//      5MB/10MB/16MB/100MB).
const request = require('supertest');
const express = require('express');
const multer = require('multer');
const { traducirErroresDeMulter } = require('./uploadErrors.middleware');
const { AppError, errorHandler } = require('./error.middleware');

describe('traducirErroresDeMulter() — unitario, middlewareMulter simulado', () => {
  const next = jest.fn();
  const req = {};
  const res = {};

  beforeEach(() => {
    next.mockClear();
  });

  test('LIMIT_FILE_SIZE → AppError 413 con el mensaje armado a partir de campoLegible/limiteLegible', () => {
    const errorMulter = new multer.MulterError('LIMIT_FILE_SIZE');
    const middlewareFalso = (_req, _res, cb) => cb(errorMulter);
    const middleware = traducirErroresDeMulter(middlewareFalso, { campoLegible: 'video de presentación', limiteLegible: '16MB' });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const errorRecibido = next.mock.calls[0][0];
    expect(errorRecibido).toBeInstanceOf(AppError);
    expect(errorRecibido.statusCode).toBe(413);
    expect(errorRecibido.message).toBe('El archivo excede el límite de 16MB para video de presentación.');
  });

  test('otro código de MulterError (ej. LIMIT_UNEXPECTED_FILE) → AppError 400, nunca un 500 sin traducir', () => {
    const errorMulter = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'campo-x');
    const middlewareFalso = (_req, _res, cb) => cb(errorMulter);
    const middleware = traducirErroresDeMulter(middlewareFalso, { campoLegible: 'el logo', limiteLegible: '5MB' });

    middleware(req, res, next);

    const errorRecibido = next.mock.calls[0][0];
    expect(errorRecibido).toBeInstanceOf(AppError);
    expect(errorRecibido.statusCode).toBe(400);
    expect(errorRecibido.message).not.toMatch(/^Unexpected field$/); // no el mensaje crudo de Multer sin envolver en AppError
  });

  test('un AppError que ya viene de fileFilter() (tipo de archivo no permitido) pasa TAL CUAL, sin reenvolver', () => {
    const errorDeFileFilter = new AppError('Tipo de imagen no permitido. Use JPG, PNG o WEBP', 400);
    const middlewareFalso = (_req, _res, cb) => cb(errorDeFileFilter);
    const middleware = traducirErroresDeMulter(middlewareFalso, { campoLegible: 'el logo', limiteLegible: '5MB' });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(errorDeFileFilter); // misma referencia, no una copia
  });

  test('sin error: llama a next() sin argumentos, deja pasar la request normal', () => {
    const middlewareFalso = (_req, _res, cb) => cb();
    const middleware = traducirErroresDeMulter(middlewareFalso, { campoLegible: 'el logo', limiteLegible: '5MB' });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe('traducirErroresDeMulter() — HTTP real (supertest + Express + multer real + errorHandler real)', () => {
  // Límites chicos a propósito (bytes, no MB) — se prueba la traducción del
  // error, no los límites reales de negocio (ya confirmados en
  // business.routes.js: 5MB logo/fotos, 10MB PDF informativo, 16MB video,
  // 100MB brochure).
  const CAMPOS = [
    { ruta: '/logo', campoMultipart: 'logo', campoLegible: 'el logo', limiteLegible: '5MB', limiteBytes: 10 },
    { ruta: '/pdf', campoMultipart: 'pdf', campoLegible: 'el PDF informativo', limiteLegible: '10MB', limiteBytes: 10 },
    { ruta: '/presentation-video', campoMultipart: 'video', campoLegible: 'video de presentación', limiteLegible: '16MB', limiteBytes: 10 },
    { ruta: '/brochure', campoMultipart: 'brochure', campoLegible: 'el brochure', limiteLegible: '100MB', limiteBytes: 10 },
  ];

  const app = express();
  for (const campo of CAMPOS) {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: campo.limiteBytes } });
    app.post(
      campo.ruta,
      traducirErroresDeMulter(upload.single(campo.campoMultipart), {
        campoLegible: campo.campoLegible,
        limiteLegible: campo.limiteLegible,
      }),
      (req, res) => res.status(200).json({ success: true }),
    );
  }
  app.use(errorHandler);

  test.each(CAMPOS)(
    'POST $ruta con un archivo que excede el límite → 413, mensaje en español con el límite real ($limiteLegible), NUNCA 500',
    async ({ ruta, campoMultipart, campoLegible, limiteLegible, limiteBytes }) => {
      const archivoDeMasico = Buffer.alloc(limiteBytes + 1, 'x');

      const res = await request(app).post(ruta).attach(campoMultipart, archivoDeMasico, 'archivo-de-prueba.bin');

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe(`El archivo excede el límite de ${limiteLegible} para ${campoLegible}.`);
    },
  );

  test.each(CAMPOS)('POST $ruta con un archivo DENTRO del límite → 200, sigue funcionando normal', async ({ ruta, campoMultipart, limiteBytes }) => {
    const archivoOk = Buffer.alloc(Math.max(limiteBytes - 1, 1), 'x');

    const res = await request(app).post(ruta).attach(campoMultipart, archivoOk, 'archivo-de-prueba.bin');

    expect(res.status).toBe(200);
  });
});
