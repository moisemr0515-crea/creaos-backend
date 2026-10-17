// Registro único de ventas (colección `sales`): modelo, índices y crearVenta(). El cierre de venta que la alimenta
// (lead.service#cerrarVenta) se prueba en lead/lead.service.cerrarVenta.ventas.test.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Sale = require('./sale.model');
const { crearVenta } = require('./sale.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_sales_model';
const AHORA = new Date('2026-10-17T15:00:00Z');

describe('Sale — modelo e índices', () => {
  let negocioA;
  let negocioB;
  let leadA;
  let leadB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Sale.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Business.deleteMany({})]);
    negocioA = await Business.create({ name: 'Negocio A', country: 'PE' }); // moneda PEN
    negocioB = await Business.create({ name: 'Negocio B', country: 'MX' }); // moneda MXN
    leadA = await Lead.create({ business: negocioA._id, name: 'Lead A' });
    leadB = await Lead.create({ business: negocioB._id, name: 'Lead B' });
  });

  const venta = (extra = {}) => ({
    leadId: leadA._id, amount: 100, origin: 'manual', status: 'confirmed', closedAt: AHORA, ...extra,
  });

  describe('validación del esquema', () => {
    const base = () => ({ business: negocioA._id, lead: leadA._id, amount: 10, origin: 'manual', status: 'confirmed', closedAt: AHORA });

    test('una venta válida se guarda con createdAt automática', async () => {
      const s = await Sale.create(base());
      expect(s.createdAt).toBeInstanceOf(Date);
      expect(s.updatedAt).toBeUndefined(); // "nada más": solo createdAt
    });

    test.each([['origin', 'efectivo'], ['status', 'cancelada']])('%s fuera del enum se rechaza', async (campo, valor) => {
      await expect(Sale.create({ ...base(), [campo]: valor })).rejects.toThrow(/is not a valid enum value/);
    });

    test.each(['manual', 'ai_proposal', 'receipt', 'crea_pay'])('origin "%s" es válido', async (origin) => {
      await expect(Sale.create({ ...base(), origin })).resolves.toBeDefined();
    });

    test('business, lead, amount, origin y status son obligatorios', async () => {
      for (const campo of ['business', 'lead', 'amount', 'origin', 'status']) {
        const datos = base();
        delete datos[campo];
        // eslint-disable-next-line no-await-in-loop
        await expect(Sale.create(datos)).rejects.toThrow(new RegExp(campo));
      }
    });

    test('amount negativo se rechaza; amount 0 SE GUARDA (no cuenta como "Vendido", eso lo decide Estadísticas)', async () => {
      await expect(Sale.create({ ...base(), amount: -1 })).rejects.toThrow(/amount/);
      const cero = await Sale.create({ ...base(), amount: 0 });
      expect(cero.amount).toBe(0);
    });

    test('confirmada exige closedAt; por confirmar no lo tiene todavía', async () => {
      await expect(Sale.create({ ...base(), closedAt: null })).rejects.toThrow(/fecha de cierre/);
      await expect(Sale.create({ ...base(), status: 'pending' })).rejects.toThrow(/todavía/);
      await expect(Sale.create({ ...base(), status: 'pending', closedAt: null })).resolves.toBeDefined();
    });

    test('currency: 3 letras en mayúsculas o null; basura se rechaza', async () => {
      expect((await Sale.create({ ...base(), currency: 'pen' })).currency).toBe('PEN');
      expect((await Sale.create(base())).currency).toBeNull();
      await expect(Sale.create({ ...base(), currency: 'SOLES' })).rejects.toThrow(/currency/);
    });
  });

  describe('índices', () => {
    test('existen {business,status,closedAt:-1}, {business,lead} y el único parcial {business,ref}', async () => {
      const indices = await Sale.collection.indexes();
      const clave = (k) => JSON.stringify(k);
      const porClave = Object.fromEntries(indices.map((i) => [clave(i.key), i]));

      expect(porClave[clave({ business: 1, status: 1, closedAt: -1 })]).toBeDefined();
      expect(porClave[clave({ business: 1, lead: 1 })]).toBeDefined();
      const unico = porClave[clave({ business: 1, ref: 1 })];
      expect(unico.unique).toBe(true);
      expect(unico.partialFilterExpression).toEqual({ ref: { $type: 'string' } });
    });

    test('ref duplicado en el mismo negocio se rechaza; en otro negocio se permite; sin ref no choca', async () => {
      await crearVenta(negocioA._id, venta({ ref: 'pago-1' }));
      await expect(crearVenta(negocioA._id, venta({ ref: 'pago-1' }))).rejects.toMatchObject({ statusCode: 409 });
      await expect(crearVenta(negocioB._id, venta({ leadId: leadB._id, ref: 'pago-1' }))).resolves.toBeDefined();

      await crearVenta(negocioA._id, venta());
      await crearVenta(negocioA._id, venta());
      expect(await Sale.countDocuments({ business: negocioA._id, ref: { $exists: false } })).toBe(2);
      expect(await Sale.countDocuments({ business: negocioA._id, ref: 'pago-1' })).toBe(1);
    });
  });

  describe('crearVenta(businessId, …)', () => {
    test('guarda la venta del negocio con la moneda de ESE negocio', async () => {
      const a = await crearVenta(negocioA._id, venta());
      const b = await crearVenta(negocioB._id, venta({ leadId: leadB._id }));

      expect(String(a.business)).toBe(String(negocioA._id));
      expect(a.currency).toBe('PEN');
      expect(b.currency).toBe('MXN');
    });

    test('negocio sin moneda definida: currency null (no se inventa USD ni MXN)', async () => {
      const sinMoneda = await Business.create({ name: 'Negocio CL', country: 'CL' }); // fuera de la tabla → null
      const lead = await Lead.create({ business: sinMoneda._id, name: 'Lead CL' });
      const s = await crearVenta(sinMoneda._id, venta({ leadId: lead._id }));
      expect(s.currency).toBeNull();
    });

    test('AISLAMIENTO: un lead de OTRO negocio da 404 y no se crea nada', async () => {
      await expect(crearVenta(negocioA._id, venta({ leadId: leadB._id }))).rejects.toMatchObject({ statusCode: 404 });
      await expect(crearVenta(negocioB._id, venta({ leadId: leadA._id }))).rejects.toMatchObject({ statusCode: 404 });
      expect(await Sale.countDocuments({})).toBe(0);
    });

    test('lead inexistente: 404', async () => {
      await expect(crearVenta(negocioA._id, venta({ leadId: new mongoose.Types.ObjectId() }))).rejects.toMatchObject({ statusCode: 404 });
    });

    test('AISLAMIENTO: las ventas de cada negocio quedan en el suyo', async () => {
      await crearVenta(negocioA._id, venta());
      await crearVenta(negocioA._id, venta({ amount: 50 }));
      await crearVenta(negocioB._id, venta({ leadId: leadB._id, amount: 70 }));

      expect(await Sale.countDocuments({ business: negocioA._id })).toBe(2);
      expect(await Sale.countDocuments({ business: negocioB._id })).toBe(1);
      expect((await Sale.find({ business: negocioB._id }))[0].amount).toBe(70);
    });
  });
});
