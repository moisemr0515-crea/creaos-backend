// Datos reales de la tarjeta de WhatsApp en Conexiones: fecha de conexión, leads con origen WhatsApp y última actividad.
// Siempre del negocio del token; null si no hay dato o no hay permiso (nunca un 0 inventado). Mongo real.
const mongoose = require('mongoose');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const { obtenerMetricasDeWhatsapp } = require('./whatsapp.metrics.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_whatsapp_metricas';
const D = (iso) => new Date(iso);

describe('obtenerMetricasDeWhatsapp', () => {
  const negocioA = new mongoose.Types.ObjectId();
  const negocioB = new mongoose.Types.ObjectId();
  const canal = { createdAt: D('2026-10-15T14:30:00Z') };
  const completo = { negocioCompleto: true };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Promise.all([Lead.deleteMany({}), Conversation.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([Lead.deleteMany({}), Conversation.deleteMany({})]);
    jest.restoreAllMocks();
  });

  let seq = 0;
  const lead = (business, extra = {}) => {
    seq += 1;
    return Lead.collection.insertOne({
      business, name: `Lead ${seq}`, source: 'whatsapp', isDeleted: false, isArchived: false,
      createdAt: D('2026-10-01T12:00:00Z'), updatedAt: D('2026-10-01T12:00:00Z'), ...extra,
    });
  };
  const conversacion = (business, lastInboundMessageAt, extra = {}) => Conversation.collection.insertOne({
    business, lead: new mongoose.Types.ObjectId(), channel: 'whatsapp', status: 'active', isDeleted: false,
    lastInboundMessageAt, createdAt: new Date(), updatedAt: new Date(), ...extra,
  });

  describe('fecha de conexión', () => {
    it('es la fecha en que se guardó el canal (createdAt), en ISO', async () => {
      const m = await obtenerMetricasDeWhatsapp(negocioA, canal, completo);
      expect(m.connectedAt).toBe('2026-10-15T14:30:00.000Z');
    });

    it('sin fecha en el canal queda null', async () => {
      expect((await obtenerMetricasDeWhatsapp(negocioA, {}, completo)).connectedAt).toBeNull();
      expect((await obtenerMetricasDeWhatsapp(negocioA, null, completo)).connectedAt).toBeNull();
    });
  });

  describe('leads recibidos', () => {
    it('cuenta solo los leads de WhatsApp del negocio del token', async () => {
      await lead(negocioA);
      await lead(negocioA);
      await lead(negocioA, { source: 'facebook' });
      await lead(negocioA, { source: 'manual' });
      await lead(negocioB); // otro negocio: no cuenta
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).leadsReceived).toBe(2);
      expect((await obtenerMetricasDeWhatsapp(negocioB, canal, completo)).leadsReceived).toBe(1);
    });

    it('no cuenta los eliminados; los archivados sí', async () => {
      await lead(negocioA);
      await lead(negocioA, { isDeleted: true });
      await lead(negocioA, { isArchived: true });
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).leadsReceived).toBe(2);
    });

    it('un negocio sin leads de WhatsApp devuelve 0 de verdad (no null)', async () => {
      await lead(negocioA, { source: 'manual' });
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).leadsReceived).toBe(0);
    });
  });

  describe('última actividad', () => {
    it('es el último mensaje entrante del negocio (el máximo), en ISO', async () => {
      await conversacion(negocioA, D('2026-10-10T10:00:00Z'));
      await conversacion(negocioA, D('2026-10-16T08:15:00Z'));
      await conversacion(negocioA, D('2026-10-12T10:00:00Z'));
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).lastActivityAt).toBe('2026-10-16T08:15:00.000Z');
    });

    it('no mira conversaciones de otro negocio ni eliminadas', async () => {
      await conversacion(negocioA, D('2026-10-10T10:00:00Z'));
      await conversacion(negocioB, D('2026-10-17T10:00:00Z'));
      await conversacion(negocioA, D('2026-10-17T11:00:00Z'), { isDeleted: true });
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).lastActivityAt).toBe('2026-10-10T10:00:00.000Z');
    });

    it('sin mensajes entrantes queda null', async () => {
      await conversacion(negocioA, null);
      expect((await obtenerMetricasDeWhatsapp(negocioA, canal, completo)).lastActivityAt).toBeNull();
      expect((await obtenerMetricasDeWhatsapp(negocioB, canal, completo)).lastActivityAt).toBeNull();
    });
  });

  describe('permiso: métricas de todo el negocio', () => {
    it('sin negocioCompleto (p. ej. Ventas con leads:own) solo da la fecha y NO consulta nada', async () => {
      await lead(negocioA);
      await conversacion(negocioA, D('2026-10-16T08:15:00Z'));
      const contar = jest.spyOn(Lead, 'countDocuments');
      const buscar = jest.spyOn(Conversation, 'findOne');
      const m = await obtenerMetricasDeWhatsapp(negocioA, canal);
      expect(m).toEqual({ connectedAt: '2026-10-15T14:30:00.000Z', leadsReceived: null, lastActivityAt: null });
      expect(contar).not.toHaveBeenCalled();
      expect(buscar).not.toHaveBeenCalled();
    });
  });

  describe('si una consulta falla', () => {
    it('ese dato queda en null y no lanza (el estado del canal no se rompe)', async () => {
      await conversacion(negocioA, D('2026-10-16T08:15:00Z'));
      jest.spyOn(Lead, 'countDocuments').mockRejectedValue(new Error('boom'));
      const m = await obtenerMetricasDeWhatsapp(negocioA, canal, completo);
      expect(m.leadsReceived).toBeNull();
      expect(m.lastActivityAt).toBe('2026-10-16T08:15:00.000Z'); // la otra consulta sigue valiendo
      expect(m.connectedAt).toBe('2026-10-15T14:30:00.000Z');
    });
  });
});
