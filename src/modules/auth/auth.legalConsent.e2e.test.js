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
const { CURRENT_LEGAL_VERSIONS } = require('../../config/legalDocuments');

describe('POST /api/v1/auth/register — consentimiento legal versionado', () => {
  const validBody = {
    name: 'Owner Legal',
    email: 'owner.legal@example.com',
    password: 'Password1',
    businessName: 'Negocio Legal',
    legalAcceptance: { termsAccepted: true, privacyAccepted: true, ...CURRENT_LEGAL_VERSIONS },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    authService.registrar.mockResolvedValue({
      usuario: { _id: 'u-legal', email: validBody.email, isEmailVerified: false },
    });
  });

  test('publica las versiones legales vigentes desde la fuente server-side', async () => {
    const res = await request(app).get('/api/v1/auth/legal-documents').expect(200);
    expect(res.body.data).toEqual(CURRENT_LEGAL_VERSIONS);
  });

  test('registro con aceptación y versiones vigentes pasa al servicio con contexto técnico', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .set('user-agent', 'CREA-OS legal consent test')
      .send(validBody)
      .expect(201);

    expect(authService.registrar).toHaveBeenCalledWith(expect.objectContaining({
      legalAcceptance: validBody.legalAcceptance,
      legalContext: expect.objectContaining({
        ip: expect.any(String),
        userAgent: 'CREA-OS legal consent test',
      }),
    }));
  });

  test('registro sin aceptación es rechazado antes del servicio', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validBody, legalAcceptance: undefined })
      .expect(422);

    expect(authService.registrar).not.toHaveBeenCalled();
  });

  test('registro sin aceptación de Términos es rechazado', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...validBody,
        legalAcceptance: { ...validBody.legalAcceptance, termsAccepted: false },
      })
      .expect(422);

    expect(authService.registrar).not.toHaveBeenCalled();
  });

  test('registro sin aceptación de Privacidad es rechazado', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...validBody,
        legalAcceptance: { ...validBody.legalAcceptance, privacyAccepted: false },
      })
      .expect(422);

    expect(authService.registrar).not.toHaveBeenCalled();
  });

  test('versiones desactualizadas son rechazadas server-side', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        ...validBody,
        legalAcceptance: { ...validBody.legalAcceptance, termsVersion: '0.9.0' },
      })
      .expect(422);

    expect(authService.registrar).not.toHaveBeenCalled();
  });
});
