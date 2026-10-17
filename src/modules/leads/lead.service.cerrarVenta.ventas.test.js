// cerrarVenta() alimenta el registro único de ventas (`sales`). Mongo local es standalone: aquí corre la rama de fallback sin
// transacción (la reversión transaccional real es de MongoDB en Atlas, ver lead.service.cerrarVenta.test.js); lo que SÍ se
// prueba es la corrección funcional completa, incluido que "si falla la venta, el lead no queda cerrado".
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Product = require('../products/product.model');
const Sale = require('../sales/sale.model');
const Lead = require('./lead.model');
const { cerrarVenta } = require('./lead.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_cerrar_venta_ventas';

describe('lead.service#cerrarVenta() — registro de ventas', () => {
  let negocio;
  let pipeline;
  let lead;
  const actor = { _id: new mongoose.Types.ObjectId(), name: 'Actor de prueba' };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Sale.syncIndexes();
  });

  afterAll(async () => {
    await Promise.all([Sale.deleteMany({}), Product.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([Sale.deleteMany({}), Product.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio de prueba', country: 'PE' }); // PEN
    pipeline = await Pipeline.createDefault(negocio._id, actor._id);
    lead = await Lead.create({ business: negocio._id, name: 'Lead de prueba', pipeline: pipeline._id, pipelineStage: 'negotiating' });
  });

  describe('cierre normal', () => {
    test('crea UNA venta manual confirmada con la moneda del negocio y la fecha del cierre', async () => {
      const antes = Date.now();
      const cerrado = await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 850 });

      const ventas = await Sale.find({});
      expect(ventas).toHaveLength(1);
      expect(ventas[0]).toMatchObject({ amount: 850, currency: 'PEN', origin: 'manual', status: 'confirmed' });
      expect(String(ventas[0].business)).toBe(String(negocio._id));
      expect(String(ventas[0].lead)).toBe(String(lead._id));
      expect(ventas[0].closedAt.getTime()).toBeGreaterThanOrEqual(antes);
      expect(ventas[0].closedAt.getTime()).toBe(cerrado.stageChangedAt.getTime()); // mismo instante que el cierre del lead
    });

    test('los campos del lead siguen igual que antes: actualValue, saleClosedAt, etapa, probabilidad, fechas e historial', async () => {
      const cerrado = await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 850 });
      const releido = await Lead.findById(lead._id);

      for (const l of [cerrado, releido]) {
        expect(l.actualValue).toBe(850);
        expect(l.saleClosedAt).toBeInstanceOf(Date);
        expect(l.pipelineStage).toBe('won');
        expect(l.closeProbability).toBe(100);
        expect(l.stageChangedAt).toBeInstanceOf(Date);
        expect(l.lastContactedAt).toBeInstanceOf(Date);
      }
      const ultima = releido.activity[releido.activity.length - 1];
      expect(ultima).toMatchObject({ type: 'stage_changed', description: 'Venta cerrada por Actor de prueba' });
      expect(ultima.meta).toMatchObject({ from: 'negotiating', to: 'won', actualValue: 850 });
    });

    test('IDEMPOTENTE: cerrar dos veces deja UNA sola venta y no pisa el monto', async () => {
      await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 500 });
      const segunda = await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 999 });

      expect(segunda.actualValue).toBe(500);
      const ventas = await Sale.find({});
      expect(ventas).toHaveLength(1);
      expect(ventas[0].amount).toBe(500);
    });

    test('IDEMPOTENTE bajo carrera: dos cierres simultáneos dejan UNA sola venta', async () => {
      await Promise.all([
        cerrarVenta(negocio._id, lead._id, actor, { actualValue: 300 }),
        cerrarVenta(negocio._id, lead._id, actor, { actualValue: 300 }),
      ]);
      expect(await Sale.countDocuments({})).toBe(1);
    });

    test('monto 0: se guarda la venta (queda como "sin monto", Estadísticas decide no contarla)', async () => {
      await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 0 });
      const venta = await Sale.findOne({});
      expect(venta.amount).toBe(0);
      expect(venta.status).toBe('confirmed');
    });
  });

  describe('aislamiento entre negocios', () => {
    test('lead de OTRO negocio: 404 y no se crea ninguna venta (ni en uno ni en otro)', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' });
      await expect(cerrarVenta(otro._id, lead._id, actor, { actualValue: 100 })).rejects.toMatchObject({ statusCode: 404 });

      expect(await Sale.countDocuments({})).toBe(0);
      expect((await Lead.findById(lead._id)).saleClosedAt).toBeNull();
    });

    test('cada negocio guarda SU venta con SU moneda', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' }); // MXN
      const pipelineOtro = await Pipeline.createDefault(otro._id, actor._id);
      const leadOtro = await Lead.create({ business: otro._id, name: 'Lead otro', pipeline: pipelineOtro._id, pipelineStage: 'negotiating' });

      await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 100 });
      await cerrarVenta(otro._id, leadOtro._id, actor, { actualValue: 200 });

      expect(await Sale.findOne({ business: negocio._id })).toMatchObject({ amount: 100, currency: 'PEN' });
      expect(await Sale.findOne({ business: otro._id })).toMatchObject({ amount: 200, currency: 'MXN' });
      expect(await Sale.countDocuments({})).toBe(2);
    });
  });

  describe('si falla la venta, el lead no queda cerrado', () => {
    test('Sale.create falla → el cierre se deshace: el lead queda como estaba y no hay venta', async () => {
      const antes = await Lead.findById(lead._id);
      jest.spyOn(Sale, 'create').mockRejectedValue(new Error('fallo simulado al guardar la venta'));

      await expect(cerrarVenta(negocio._id, lead._id, actor, { actualValue: 850 })).rejects.toThrow('fallo simulado');

      const despues = await Lead.findById(lead._id);
      expect(despues.saleClosedAt).toBeNull();
      expect(despues.actualValue).toBeUndefined();
      expect(despues.pipelineStage).toBe('negotiating');
      expect(despues.closeProbability).toBe(antes.closeProbability);
      expect(despues.activity).toHaveLength(antes.activity.length); // la actividad del cierre también se quita
      expect(await Sale.countDocuments({})).toBe(0);
    });

    test('tras el fallo, un reintento sí cierra y crea la venta', async () => {
      const spy = jest.spyOn(Sale, 'create').mockRejectedValueOnce(new Error('fallo simulado'));
      await expect(cerrarVenta(negocio._id, lead._id, actor, { actualValue: 850 })).rejects.toThrow('fallo simulado');
      spy.mockRestore();

      await cerrarVenta(negocio._id, lead._id, actor, { actualValue: 850 });
      expect(await Sale.countDocuments({})).toBe(1);
      expect((await Lead.findById(lead._id)).saleClosedAt).toBeInstanceOf(Date);
    });

    test('stock insuficiente (409): tampoco queda el lead cerrado ni hay venta', async () => {
      const producto = await Product.create({ business: negocio._id, sku: 'P-1', name: 'Producto', physicalStock: 1, trackInventory: true });

      await expect(
        cerrarVenta(negocio._id, lead._id, actor, { actualValue: 100, items: [{ productId: producto._id, quantity: 99 }] })
      ).rejects.toMatchObject({ statusCode: 409 });

      expect((await Lead.findById(lead._id)).saleClosedAt).toBeNull();
      expect(await Sale.countDocuments({})).toBe(0);
    });
  });

  describe('lead que YA está en una etapa ganada (registrar el monto)', () => {
    const CIERRE_ORIGINAL = new Date('2026-09-10T14:00:00Z');
    let ganado;

    beforeEach(async () => {
      ganado = await Lead.create({
        business: negocio._id, name: 'Ganado antiguo', pipeline: pipeline._id, pipelineStage: 'won',
        stageChangedAt: CIERRE_ORIGINAL, closeProbability: 100,
      });
    });

    test('NO toca stageChangedAt ni la etapa, y la venta nace con el cierre ORIGINAL', async () => {
      const resultado = await cerrarVenta(negocio._id, ganado._id, actor, { actualValue: 640 });

      expect(resultado.stageChangedAt.toISOString()).toBe(CIERRE_ORIGINAL.toISOString());
      expect(resultado.pipelineStage).toBe('won');
      expect(resultado.actualValue).toBe(640);
      expect(resultado.saleClosedAt).toBeInstanceOf(Date);

      const releido = await Lead.findById(ganado._id);
      expect(releido.stageChangedAt.toISOString()).toBe(CIERRE_ORIGINAL.toISOString());

      const venta = await Sale.findOne({ lead: ganado._id });
      expect(venta).toMatchObject({ amount: 640, origin: 'manual', status: 'confirmed', currency: 'PEN' });
      expect(venta.closedAt.toISOString()).toBe(CIERRE_ORIGINAL.toISOString());
    });

    test('el historial anota "monto registrado" (no "venta cerrada") y no se mueve lastContactedAt', async () => {
      const antes = await Lead.findById(ganado._id);
      await cerrarVenta(negocio._id, ganado._id, actor, { actualValue: 640 });

      const releido = await Lead.findById(ganado._id);
      const ultima = releido.activity[releido.activity.length - 1];
      expect(ultima.description).toBe('Monto registrado por Actor de prueba');
      expect(ultima.type).toBe('updated');
      expect(ultima.meta).toMatchObject({ actualValue: 640, stage: 'won' });
      expect(String(releido.lastContactedAt)).toBe(String(antes.lastContactedAt));
    });

    test('sin stageChangedAt (lead antiguo): la venta usa updatedAt como fecha de cierre', async () => {
      const sinFecha = await Lead.create({ business: negocio._id, name: 'Sin fecha', pipeline: pipeline._id, pipelineStage: 'won' });
      expect(sinFecha.stageChangedAt).toBeUndefined();

      await cerrarVenta(negocio._id, sinFecha._id, actor, { actualValue: 90 });

      const venta = await Sale.findOne({ lead: sinFecha._id });
      expect(venta.closedAt.toISOString()).toBe(sinFecha.updatedAt.toISOString());
      expect((await Lead.findById(sinFecha._id)).stageChangedAt).toBeUndefined(); // tampoco se inventa una
    });

    test('NO descuenta stock: con items se rechaza (400) y no se toca nada', async () => {
      const producto = await Product.create({ business: negocio._id, sku: 'P-2', name: 'Producto', physicalStock: 10, trackInventory: true });

      await expect(
        cerrarVenta(negocio._id, ganado._id, actor, { actualValue: 100, items: [{ productId: producto._id, quantity: 2 }] })
      ).rejects.toMatchObject({ statusCode: 400 });

      expect((await Product.findById(producto._id)).physicalStock).toBe(10);
      expect((await Lead.findById(ganado._id)).saleClosedAt).toBeNull();
      expect(await Sale.countDocuments({})).toBe(0);
    });

    test('es idempotente: registrar dos veces el monto deja una sola venta y la fecha original', async () => {
      await cerrarVenta(negocio._id, ganado._id, actor, { actualValue: 640 });
      await cerrarVenta(negocio._id, ganado._id, actor, { actualValue: 777 });

      const ventas = await Sale.find({ lead: ganado._id });
      expect(ventas).toHaveLength(1);
      expect(ventas[0].amount).toBe(640);
      expect(ventas[0].closedAt.toISOString()).toBe(CIERRE_ORIGINAL.toISOString());
    });

    test('con un pipeline propio de varias etapas ganadas, queda en SU etapa ganada (no salta a la primera)', async () => {
      const propio = await Pipeline.create({
        business: negocio._id, name: 'Propio', isDefault: false,
        stages: [
          { key: 'nuevo', name: 'Nuevo', order: 1, color: '#111111' },
          { key: 'cerrado_a', name: 'Cerrado A', order: 2, color: '#222222', isWon: true, defaultProbability: 100 },
          { key: 'cerrado_b', name: 'Cerrado B', order: 3, color: '#333333', isWon: true, defaultProbability: 100 },
        ],
      });
      const enB = await Lead.create({
        business: negocio._id, name: 'En B', pipeline: propio._id, pipelineStage: 'cerrado_b', stageChangedAt: CIERRE_ORIGINAL,
      });

      const resultado = await cerrarVenta(negocio._id, enB._id, actor, { actualValue: 55 });

      expect(resultado.pipelineStage).toBe('cerrado_b');
      expect(resultado.stageChangedAt.toISOString()).toBe(CIERRE_ORIGINAL.toISOString());
    });
  });
});
