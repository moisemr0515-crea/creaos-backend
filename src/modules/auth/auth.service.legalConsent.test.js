const crypto = require('crypto');
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Role = require('../roles/role.model');
const User = require('../users/user.model');
const { CURRENT_LEGAL_VERSIONS } = require('../../config/legalDocuments');
const { hashPassword } = require('../../utils/crypto');

jest.mock('../../utils/email', () => ({
  enviarEmailVerificacion: jest.fn().mockResolvedValue(undefined),
  enviarEmailResetPassword: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../config/redis', () => ({
  getRedis: () => ({
    setex: jest.fn().mockResolvedValue('OK'),
  }),
}));

const { registrar, login } = require('./auth.service');
const MONGO_URI = 'mongodb://localhost:27017/creaos_test_auth_legal_consent';

describe('auth.registrar — evidencia legal persistida', () => {
  const acceptance = {
    termsAccepted: true,
    privacyAccepted: true,
    ...CURRENT_LEGAL_VERSIONS,
  };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Role.findOneAndUpdate(
      { slug: 'owner', business: null },
      { name: 'Owner', slug: 'owner', business: null, isSystem: true, permissions: [] },
      { upsert: true, new: true }
    );
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Business.deleteMany({});
    await Role.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await User.deleteMany({});
    await Business.deleteMany({});
  });

  const forceStandalone = () => jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: jest.fn().mockRejectedValue(new Error('Transaction numbers are only allowed on a replica set member')),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  test('persiste Términos y Privacidad con versión, fecha y contexto minimizado', async () => {
    forceStandalone();
    const before = new Date();

    const result = await registrar({
      name: 'Owner Consent',
      email: 'consent@example.com',
      password: 'Password1',
      businessName: 'Negocio Consent',
      legalAcceptance: acceptance,
      legalContext: { ip: '203.0.113.10', userAgent: 'CREA-OS Test Browser' },
    });

    const publicUser = await User.findById(result.usuario._id);
    expect(publicUser.legalConsents).toBeUndefined();

    const user = await User.findById(result.usuario._id).select('+legalConsents');
    expect(user.legalConsents).toHaveLength(2);
    expect(user.legalConsents.map((c) => ({ documentType: c.documentType, documentVersion: c.documentVersion }))).toEqual([
      { documentType: 'terms', documentVersion: CURRENT_LEGAL_VERSIONS.termsVersion },
      { documentType: 'privacy', documentVersion: CURRENT_LEGAL_VERSIONS.privacyVersion },
    ]);
    expect(user.legalConsents.every((c) => c.acceptedAt >= before)).toBe(true);
    expect(user.legalConsents.every((c) => c.source === 'registration')).toBe(true);
    expect(user.legalConsents.every((c) => c.context.ipHash === crypto.createHash('sha256').update('203.0.113.10').digest('hex'))).toBe(true);
    expect(user.legalConsents.every((c) => c.context.userAgent === 'CREA-OS Test Browser')).toBe(true);
    expect(JSON.stringify(user.legalConsents)).not.toContain('203.0.113.10');
  });

  test('rechaza aceptación ausente o con versión no vigente sin crear datos', async () => {
    await expect(registrar({
      name: 'Invalid Consent',
      email: 'invalid@example.com',
      password: 'Password1',
      businessName: 'Invalid Business',
      legalAcceptance: {
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: '0.9.0',
        privacyVersion: '0.9.0',
      },
    })).rejects.toMatchObject({ statusCode: 422 });

    expect(await User.countDocuments({})).toBe(0);
    expect(await Business.countDocuments({})).toBe(0);
  });

  test('usuario legacy sin historial legal puede iniciar sesión sin reconsent', async () => {
    const role = await Role.findOne({ slug: 'owner', business: null });
    const business = await Business.create({ name: 'Legacy Business' });
    const user = await User.create({
      name: 'Legacy User',
      email: 'legacy@example.com',
      password: await hashPassword('Password1'),
      role: role._id,
      business: business._id,
      isEmailVerified: true,
    });

    const stored = await User.findById(user._id).select('+legalConsents');
    expect(stored.legalConsents).toEqual([]);
    await expect(login({ email: 'legacy@example.com', password: 'Password1' }))
      .resolves.toMatchObject({ usuario: { email: 'legacy@example.com' } });
  });
});
