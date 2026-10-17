// Estadísticas calculadas en el servidor (Mongo real): "Vendido" sale de `sales`, "En conversaciones" de los leads abiertos.
// Zona horaria del negocio (Perú → America/Lima), monedas por separado, sin el tope de 20 leads y aislado por negocio.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Sale = require('../sales/sale.model');
const { obtenerResumen } = require('./stats.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_stats_servicio';
const AHORA = new Date('2026-10-17T15:00:00Z'); // 10:00 en Lima, mes en curso = octubre
const D = (iso) => new Date(iso);

describe('stats.service#obtenerResumen()', () => {
  let negocio; // Perú → PEN, America/Lima
  let pipeline;
  let leadSeq = 0;
  const actor = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Promise.all([Sale.syncIndexes(), Lead.init()]);
  });

  afterAll(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio Lima', country: 'PE' });
    pipeline = await Pipeline.createDefault(negocio._id, actor);
  });

  const lead = (extra = {}, negocioId = negocio._id, pipelineId = pipeline._id) => {
    leadSeq += 1;
    return Lead.create({ business: negocioId, name: `Lead ${leadSeq}`, pipeline: pipelineId, pipelineStage: 'new', ...extra });
  };
  const venta = async (extra = {}, negocioId = negocio._id) => {
    const l = extra.lead || (await lead({}, negocioId, String(negocioId) === String(negocio._id) ? pipeline._id : null));
    return Sale.create({
      business: negocioId, lead: l._id, amount: 100, currency: 'PEN', origin: 'manual', status: 'confirmed', closedAt: D('2026-10-10T15:00:00Z'), ...extra.venta,
    });
  };
  const resumen = (query = {}, ahora = AHORA) => obtenerResumen(negocio._id, query, { ahora });

  describe('negocio sin datos', () => {
    test('todo en cero y listas vacías, sin lanzar', async () => {
      const r = await resumen();

      expect(r.businessCurrency).toBe('PEN');
      expect(r.period).toMatchObject({ key: 'this_month', timezone: 'America/Lima', timezoneConfigured: true });
      expect(r.vendido).toEqual({ count: 0, lastSaleAt: null, porMoneda: [] });
      expect(r.porConfirmar).toEqual({ count: 0, porMoneda: [] });
      expect(r.sinMonto).toEqual({ ganadosSinVenta: 0, ventasConMontoCero: 0, total: 0 });
      expect(r.enConversaciones).toEqual({ count: 0, totalPotencial: 0, valorEsperado: 0, listosParaCerrar: 0, top: [] });
    });

    test('un negocio que ni siquiera tiene pipeline: usa las etapas por defecto y NO crea ninguno (es una lectura)', async () => {
      await Pipeline.deleteMany({});
      const sinPipeline = await Business.create({ name: 'Sin pipeline', country: 'PE' });
      await Lead.create({ business: sinPipeline._id, name: 'Abierto', pipelineStage: 'new', potentialValue: 200, closeProbability: 50 });
      await Lead.create({ business: sinPipeline._id, name: 'Ganado', pipelineStage: 'won' });

      const r = await obtenerResumen(sinPipeline._id, {}, { ahora: AHORA });

      expect(r.enConversaciones).toMatchObject({ count: 1, totalPotencial: 200, valorEsperado: 100 });
      expect(r.sinMonto.ganadosSinVenta).toBe(1);
      expect(await Pipeline.countDocuments({})).toBe(0);
    });

    test('negocio inexistente: 404', async () => {
      await expect(obtenerResumen(new mongoose.Types.ObjectId(), {}, { ahora: AHORA })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('Vendido — ventas confirmadas por closedAt', () => {
    test('totales, cantidad, promedio y última venta del mes', async () => {
      await venta({ venta: { amount: 100, closedAt: D('2026-10-03T15:00:00Z') } });
      await venta({ venta: { amount: 250, closedAt: D('2026-10-12T15:00:00Z') } });

      const { vendido } = await resumen();

      expect(vendido.count).toBe(2);
      expect(vendido.lastSaleAt).toEqual(D('2026-10-12T15:00:00Z'));
      expect(vendido.porMoneda).toEqual([
        { currency: 'PEN', total: 350, count: 2, average: 175, lastSaleAt: D('2026-10-12T15:00:00Z'), previous: { total: 0, count: 0 } },
      ]);
    });

    test('BORDES DE MES EN LIMA: 04:30Z del 1 de octubre es 30 de septiembre en Lima (no cuenta en octubre); 05:00Z sí', async () => {
      await venta({ venta: { amount: 40, closedAt: D('2026-10-01T04:59:59Z') } }); // 23:59:59 del 30 de septiembre
      await venta({ venta: { amount: 60, closedAt: D('2026-10-01T05:00:00Z') } }); // 00:00:00 del 1 de octubre

      const octubre = await resumen({ period: 'this_month' });
      const septiembre = await resumen({ period: 'last_month' });

      expect(octubre.vendido.porMoneda[0]).toMatchObject({ total: 60, count: 1 });
      expect(septiembre.vendido.porMoneda[0]).toMatchObject({ total: 40, count: 1 });
    });

    test('el mismo cierre en un negocio con zona UTC cae en otro mes: la zona del negocio manda', async () => {
      const utc = await Business.create({ name: 'Zona UTC', country: 'PE', settings: { timezone: 'UTC' } });
      const l = await Lead.create({ business: utc._id, name: 'L' });
      await Sale.create({ business: utc._id, lead: l._id, amount: 40, currency: 'PEN', origin: 'manual', status: 'confirmed', closedAt: D('2026-10-01T04:59:59Z') });

      const r = await obtenerResumen(utc._id, { period: 'this_month' }, { ahora: AHORA });
      expect(r.vendido.porMoneda[0]).toMatchObject({ total: 40, count: 1 }); // en UTC ya es octubre
    });

    test('mes anterior', async () => {
      await venta({ venta: { amount: 500, closedAt: D('2026-09-15T15:00:00Z') } });
      await venta({ venta: { amount: 70, closedAt: D('2026-10-02T15:00:00Z') } });

      const r = await resumen({ period: 'last_month' });

      expect(r.period.key).toBe('last_month');
      expect(r.vendido.porMoneda[0]).toMatchObject({ total: 500, count: 1 });
    });

    test('rango personalizado: ambos días incluidos, en la zona del negocio', async () => {
      await venta({ venta: { amount: 1, closedAt: D('2026-10-05T04:59:00Z') } }); // 4 de octubre en Lima: fuera
      await venta({ venta: { amount: 2, closedAt: D('2026-10-05T05:00:00Z') } }); // 5 de octubre 00:00: dentro
      await venta({ venta: { amount: 4, closedAt: D('2026-10-07T04:59:00Z') } }); // 6 de octubre 23:59: dentro
      await venta({ venta: { amount: 8, closedAt: D('2026-10-07T05:00:00Z') } }); // 7 de octubre 00:00: fuera

      const r = await resumen({ period: 'custom', from: '2026-10-05', to: '2026-10-06' });

      expect(r.vendido.porMoneda[0]).toMatchObject({ total: 6, count: 2 });
    });

    test('comparación con el periodo anterior, también en una moneda que solo vendió antes', async () => {
      await venta({ venta: { amount: 300, closedAt: D('2026-10-04T15:00:00Z') } });
      await venta({ venta: { amount: 200, closedAt: D('2026-09-04T15:00:00Z') } });
      await venta({ venta: { amount: 50, currency: 'USD', closedAt: D('2026-09-20T15:00:00Z') } });

      const { vendido } = await resumen();

      const pen = vendido.porMoneda.find((m) => m.currency === 'PEN');
      const usd = vendido.porMoneda.find((m) => m.currency === 'USD');
      expect(pen).toMatchObject({ total: 300, previous: { total: 200, count: 1 } });
      expect(usd).toMatchObject({ total: 0, count: 0, previous: { total: 50, count: 1 } });
    });

    test('MONEDAS MEZCLADAS: cada moneda por separado, sin sumarse entre sí; la venta sin moneda aparte', async () => {
      await venta({ venta: { amount: 100, currency: 'PEN' } });
      await venta({ venta: { amount: 25, currency: 'USD' } });
      await venta({ venta: { amount: 40, currency: 'USD' } });
      await venta({ venta: { amount: 9, currency: null } });

      const { vendido } = await resumen();

      const por = Object.fromEntries(vendido.porMoneda.map((m) => [String(m.currency), m]));
      expect(por.PEN).toMatchObject({ total: 100, count: 1 });
      expect(por.USD).toMatchObject({ total: 65, count: 2, average: 32.5 });
      expect(por.null).toMatchObject({ total: 9, count: 1 });
      expect(vendido.count).toBe(4);
      expect(vendido.porMoneda.map((m) => m.currency)).toEqual(['PEN', 'USD', null]); // ordenadas por total, de mayor a menor
    });

    test('una venta de monto 0 NO cuenta como Vendido: queda en "sin monto"', async () => {
      await venta({ venta: { amount: 0 } });
      await venta({ venta: { amount: 80 } });

      const r = await resumen();

      expect(r.vendido.count).toBe(1);
      expect(r.vendido.porMoneda[0].total).toBe(80);
      expect(r.sinMonto.ventasConMontoCero).toBe(1);
    });

    test('el estado se filtra de verdad: una venta pendiente con fecha (dato corrupto, saltando el modelo) tampoco cuenta', async () => {
      const l = await lead();
      await Sale.collection.insertOne({
        business: negocio._id, lead: l._id, amount: 999, currency: 'PEN', origin: 'ai_proposal', status: 'pending',
        closedAt: D('2026-10-10T15:00:00Z'), createdAt: new Date(),
      });
      expect((await resumen()).vendido.count).toBe(0);
    });

    test('las ventas por confirmar no son Vendido: van a "porConfirmar" (de cualquier fecha, por moneda)', async () => {
      await venta({ venta: { status: 'pending', closedAt: null, origin: 'ai_proposal', amount: 120 } });
      await venta({ venta: { status: 'pending', closedAt: null, origin: 'ai_proposal', amount: 30, currency: 'USD' } });

      const r = await resumen();

      expect(r.vendido.count).toBe(0);
      expect(r.porConfirmar.count).toBe(2);
      expect(r.porConfirmar.porMoneda).toEqual(expect.arrayContaining([
        { currency: 'PEN', total: 120, count: 1 }, { currency: 'USD', total: 30, count: 1 },
      ]));
    });
  });

  describe('ganados sin monto', () => {
    test('un lead ganado SIN venta confirmada cuenta; con venta confirmada no; con solo una pendiente sí', async () => {
      await lead({ pipelineStage: 'won' }); // sin venta
      const conVenta = await lead({ pipelineStage: 'won' });
      await venta({ lead: conVenta });
      const soloPendiente = await lead({ pipelineStage: 'won' });
      await venta({ lead: soloPendiente, venta: { status: 'pending', closedAt: null, origin: 'ai_proposal' } });

      const r = await resumen();

      expect(r.sinMonto.ganadosSinVenta).toBe(2);
    });

    test('no mira el periodo (es trabajo por registrar), no cuenta leads borrados y sí uno archivado', async () => {
      await lead({ pipelineStage: 'won', stageChangedAt: D('2025-01-10T10:00:00Z') });
      await lead({ pipelineStage: 'won', isDeleted: true });
      await lead({ pipelineStage: 'won', isArchived: true });

      expect((await resumen({ period: 'last_month' })).sinMonto.ganadosSinVenta).toBe(2);
    });

    test('un lead abierto o perdido NO es un ganado sin monto', async () => {
      await lead({ pipelineStage: 'negotiating' });
      await lead({ pipelineStage: 'lost' });
      expect((await resumen()).sinMonto.ganadosSinVenta).toBe(0);
    });

    test('total = ganados sin venta + ventas confirmadas en 0', async () => {
      await lead({ pipelineStage: 'won' });
      await venta({ venta: { amount: 0 } });
      expect((await resumen()).sinMonto).toEqual({ ganadosSinVenta: 1, ventasConMontoCero: 1, total: 2 });
    });
  });

  describe('En conversaciones — leads abiertos', () => {
    test('más de 20 leads: no hay tope (30 leads de 100 al 50 %)', async () => {
      await Promise.all(Array.from({ length: 30 }, () => lead({ potentialValue: 100, closeProbability: 50 })));

      const { enConversaciones } = await resumen();

      expect(enConversaciones).toMatchObject({ count: 30, totalPotencial: 3000, valorEsperado: 1500 });
      expect(enConversaciones.top).toHaveLength(5);
    });

    test('valor esperado = valor × probabilidad, redondeado por lead como la pantalla (la mitad sube)', async () => {
      await lead({ potentialValue: 1000, closeProbability: 25 }); // 250
      await lead({ potentialValue: 5, closeProbability: 50 }); // 2.5 → 3

      const { enConversaciones } = await resumen();

      expect(enConversaciones.valorEsperado).toBe(253);
      expect(enConversaciones.totalPotencial).toBe(1005);
    });

    test('sin closeProbability (null) usa la temperatura: warm = 40 %', async () => {
      await Lead.collection.insertOne({
        business: negocio._id, name: 'Sin probabilidad', pipeline: pipeline._id, pipelineStage: 'new', temperature: 'warm',
        potentialValue: 500, closeProbability: null, isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
      });
      expect((await resumen()).enConversaciones.valorEsperado).toBe(200);
    });

    test('listos para cerrar: caliente O probabilidad >= 70', async () => {
      await lead({ temperature: 'hot', closeProbability: 20 });
      await lead({ temperature: 'cold', closeProbability: 70 });
      await lead({ temperature: 'cold', closeProbability: 69 });

      expect((await resumen()).enConversaciones.listosParaCerrar).toBe(2);
    });

    test('top 5 por valor esperado, de mayor a menor, solo con valor esperado > 0', async () => {
      const valores = [100, 900, 300, 700, 500, 200, 800];
      for (const v of valores) {
        // eslint-disable-next-line no-await-in-loop
        await lead({ potentialValue: v, closeProbability: 100 });
      }
      await lead({ potentialValue: 0, closeProbability: 100 }); // valor esperado 0: no entra al top

      const { top } = (await resumen()).enConversaciones;

      expect(top.map((l) => l.valorEsperado)).toEqual([900, 800, 700, 500, 300]);
      expect(top[0]).toMatchObject({ valorEstimado: 900, probabilidad: 100, name: expect.any(String) });
    });

    test('NO cuenta ganados, perdidos, archivados ni borrados', async () => {
      await lead({ potentialValue: 100, closeProbability: 50 }); // abierto
      await lead({ pipelineStage: 'won', potentialValue: 999 });
      await lead({ pipelineStage: 'lost', potentialValue: 999 });
      await lead({ potentialValue: 999, isArchived: true });
      await lead({ potentialValue: 999, isDeleted: true });

      expect((await resumen()).enConversaciones).toMatchObject({ count: 1, totalPotencial: 100 });
    });

    test('PIPELINE PROPIO: usa las etapas ganada/perdida de ESE pipeline, no un "won" fijo', async () => {
      const propio = await Pipeline.create({
        business: negocio._id, name: 'Propio', isDefault: false,
        stages: [
          { key: 'consulta', name: 'Consulta', order: 1, color: '#111111' },
          { key: 'reservado', name: 'Reservado', order: 2, color: '#222222', isWon: true },
          { key: 'descartado', name: 'Descartado', order: 3, color: '#333333', isLost: true },
        ],
      });
      const enPropio = (extra) => lead({ potentialValue: 100, closeProbability: 50, ...extra }, negocio._id, propio._id);
      await enPropio({ pipelineStage: 'consulta' }); // abierto
      await enPropio({ pipelineStage: 'reservado' }); // ganado de SU pipeline
      await enPropio({ pipelineStage: 'descartado' }); // perdido de SU pipeline
      await enPropio({ pipelineStage: 'won' }); // "won" no existe en este pipeline → cuenta como abierto
      await lead({ pipelineStage: 'won', potentialValue: 999 }); // ganado del pipeline por defecto

      const r = await resumen();

      expect(r.enConversaciones).toMatchObject({ count: 2, totalPotencial: 200 });
      expect(r.sinMonto.ganadosSinVenta).toBe(2); // 'reservado' (propio) y 'won' (por defecto)
    });

    test('un lead sin pipeline (o con uno inactivo) se mira contra el pipeline por defecto', async () => {
      const inactivo = await Pipeline.create({ business: negocio._id, name: 'Viejo', isActive: false, stages: [{ key: 'x', name: 'X', order: 1, color: '#111111', isWon: true }] });
      await Lead.create({ business: negocio._id, name: 'Sin pipeline', pipelineStage: 'won' });
      await lead({ pipelineStage: 'won' }, negocio._id, inactivo._id);
      await Lead.create({ business: negocio._id, name: 'Sin pipeline abierto', pipelineStage: 'new', potentialValue: 50, closeProbability: 100 });

      const r = await resumen();

      expect(r.sinMonto.ganadosSinVenta).toBe(2);
      expect(r.enConversaciones).toMatchObject({ count: 1, totalPotencial: 50 });
    });
  });

  describe('zona horaria sin configurar', () => {
    test('país fuera de la tabla: usa UTC y lo avisa (no inventa Ciudad de México)', async () => {
      const chile = await Business.create({ name: 'Chile', country: 'CL' });
      const r = await obtenerResumen(chile._id, {}, { ahora: AHORA });
      expect(r.period).toMatchObject({ timezone: 'UTC', timezoneConfigured: false, from: '2026-10-01T00:00:00.000Z' });
      expect(r.businessCurrency).toBeNull();
    });

    test('una zona guardada inválida también cae a UTC', async () => {
      await Business.updateOne({ _id: negocio._id }, { $set: { 'settings.timezone': 'Marte/Olympus' } });
      expect((await resumen()).period).toMatchObject({ timezone: 'UTC', timezoneConfigured: false });
    });
  });

  describe('AISLAMIENTO entre negocios', () => {
    test('cada negocio ve solo lo suyo (ventas, leads, ganados sin venta y pendientes)', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' });
      const pipelineOtro = await Pipeline.createDefault(otro._id, actor);

      await venta({ venta: { amount: 100 } });
      await lead({ potentialValue: 100, closeProbability: 100 });
      await lead({ pipelineStage: 'won' });

      const ventaOtra = await venta({ venta: { amount: 7777, currency: 'MXN' } }, otro._id);
      await Sale.create({ business: otro._id, lead: ventaOtra.lead, amount: 5, currency: 'MXN', origin: 'ai_proposal', status: 'pending' });
      await lead({ potentialValue: 9999, closeProbability: 100 }, otro._id, pipelineOtro._id);
      await lead({ pipelineStage: 'won' }, otro._id, pipelineOtro._id);
      await lead({ pipelineStage: 'won' }, otro._id, pipelineOtro._id);

      const mio = await resumen();
      const suyo = await obtenerResumen(otro._id, {}, { ahora: AHORA });

      expect(mio.vendido.porMoneda).toHaveLength(1);
      expect(mio.vendido.porMoneda[0]).toMatchObject({ currency: 'PEN', total: 100 });
      expect(mio.enConversaciones).toMatchObject({ count: 2, totalPotencial: 100 }); // el lead de la venta (abierto, sin valor) + el de 100
      expect(mio.sinMonto.ganadosSinVenta).toBe(1);
      expect(mio.porConfirmar.count).toBe(0);

      expect(suyo.vendido.porMoneda[0]).toMatchObject({ currency: 'MXN', total: 7777 });
      expect(suyo.enConversaciones).toMatchObject({ count: 2, totalPotencial: 9999 });
      expect(suyo.sinMonto.ganadosSinVenta).toBe(2);
      expect(suyo.porConfirmar.count).toBe(1);
    });
  });
});
