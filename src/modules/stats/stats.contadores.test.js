// Bloque `contadores` de GET /stats/summary: Leads, Calientes, Cerrados, tasa de cierre y cierre promedio, calculados en el servidor
// sobre TODOS los leads (antes la pantalla los calculaba con los 20 más recientes). Mismas definiciones que stats.tsx tenía. Mongo real.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const { obtenerResumen } = require('./stats.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_stats_contadores';
const AHORA = new Date('2026-10-17T15:00:00Z');
const D = (iso) => new Date(iso);

describe('stats.service — contadores', () => {
  let negocio;
  let pipeline;
  const actor = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Lead.init();
  });

  afterAll(async () => {
    await Promise.all([Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio Lima', country: 'PE' });
    pipeline = await Pipeline.createDefault(negocio._id, actor);
  });

  // Inserta directo (sin gancho de probabilidad ni timestamps automáticos) para controlar createdAt/stageChangedAt al segundo.
  let seq = 0;
  const lead = async (extra = {}, negocioId = negocio._id, pipelineId = pipeline._id) => {
    seq += 1;
    const base = {
      business: negocioId, name: `Lead ${seq}`, pipeline: pipelineId, pipelineStage: 'new', temperature: 'cold', closeProbability: 0,
      potentialValue: 0, isDeleted: false, isArchived: false, createdAt: D('2026-09-01T12:00:00Z'), updatedAt: D('2026-09-01T12:00:00Z'),
    };
    const { insertedId } = await Lead.collection.insertOne({ ...base, ...extra });
    return insertedId;
  };
  const contadores = async (query = {}, negocioId = negocio._id) => (await obtenerResumen(negocioId, query, { ahora: AHORA })).contadores;

  describe('negocio sin datos', () => {
    test('todo en cero y el cierre promedio en null (no hay ninguno que promediar), sin lanzar', async () => {
      expect(await contadores()).toEqual({ leads: 0, calientes: 0, cerrados: 0, tasaDeCierre: 0, cierrePromedioDias: null });
    });
  });

  describe('sin tope de 20 leads', () => {
    test('45 leads: 30 abiertos, 10 ganados y 5 perdidos se cuentan TODOS', async () => {
      await Promise.all([
        ...Array.from({ length: 30 }, () => lead({ pipelineStage: 'contacted' })),
        ...Array.from({ length: 10 }, () => lead({ pipelineStage: 'won', stageChangedAt: D('2026-09-11T12:00:00Z') })),
        ...Array.from({ length: 5 }, () => lead({ pipelineStage: 'lost' })),
      ]);

      const c = await contadores();

      expect(c.leads).toBe(45);
      expect(c.cerrados).toBe(10);
      expect(c.tasaDeCierre).toBe(22); // 10 / 45 = 22,2 %
    });
  });

  describe('definiciones (las que tenía stats.tsx)', () => {
    test('Leads = todos los activos: cuenta ganados y perdidos, NO borrados ni archivados', async () => {
      await lead({ pipelineStage: 'new' });
      await lead({ pipelineStage: 'won', stageChangedAt: D('2026-09-02T12:00:00Z') });
      await lead({ pipelineStage: 'lost' });
      await lead({ isDeleted: true });
      await lead({ isArchived: true });
      await lead({ pipelineStage: 'won', isArchived: true, stageChangedAt: D('2026-09-02T12:00:00Z') });

      const c = await contadores();

      expect(c.leads).toBe(3);
      expect(c.cerrados).toBe(1); // el ganado archivado tampoco
    });

    test('Calientes = abiertos con temperatura «hot» o probabilidad >= 70 (los ganados/perdidos no)', async () => {
      await lead({ temperature: 'hot', closeProbability: 10 });
      await lead({ temperature: 'cold', closeProbability: 70 });
      await lead({ temperature: 'cold', closeProbability: 69 });
      await lead({ pipelineStage: 'won', temperature: 'hot', closeProbability: 100, stageChangedAt: D('2026-09-02T12:00:00Z') });
      await lead({ pipelineStage: 'lost', temperature: 'hot' });

      expect((await contadores()).calientes).toBe(2);
    });

    test('Calientes coincide con «Listos para cerrar» de En conversaciones (una sola cifra para lo mismo)', async () => {
      await lead({ temperature: 'hot' });
      await lead({ closeProbability: 90 });
      const r = await obtenerResumen(negocio._id, {}, { ahora: AHORA });
      expect(r.contadores.calientes).toBe(r.enConversaciones.listosParaCerrar);
      expect(r.contadores.calientes).toBe(2);
    });

    test('Tasa de cierre = cerrados / todos los leads activos, redondeada (los perdidos cuentan en el total)', async () => {
      await lead({ pipelineStage: 'won', stageChangedAt: D('2026-09-02T12:00:00Z') });
      await lead({ pipelineStage: 'new' });
      await lead({ pipelineStage: 'lost' });
      expect((await contadores()).tasaDeCierre).toBe(33); // 1 / 3

      await lead({ pipelineStage: 'new' });
      expect((await contadores()).tasaDeCierre).toBe(25); // 1 / 4
    });

    test('Tasa de cierre se REDONDEA (no se trunca): 2 de 3 = 66,7 % → 67 %', async () => {
      await lead({ pipelineStage: 'won', stageChangedAt: D('2026-09-02T12:00:00Z') });
      await lead({ pipelineStage: 'won', stageChangedAt: D('2026-09-02T12:00:00Z') });
      await lead({ pipelineStage: 'new' });
      expect((await contadores()).tasaDeCierre).toBe(67);
    });
  });

  describe('cierre promedio: días entre la creación y el cierre (stageChangedAt) de los leads ganados', () => {
    test('promedio de los ganados con fecha de cierre', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') }); // 10 días
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-21T12:00:00Z') }); // 20 días

      expect((await contadores()).cierrePromedioDias).toBe(15);
    });

    test('sin redondear: 10,5 días se devuelve como 10.5 (la pantalla decide cómo mostrarlo)', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T00:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') });
      expect((await contadores()).cierrePromedioDias).toBe(10.5);
    });

    test('un ganado SIN fecha de cierre cuenta como cerrado pero no entra al promedio', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') });
      await lead({ pipelineStage: 'won' }); // sin stageChangedAt
      const c = await contadores();
      expect(c.cerrados).toBe(2);
      expect(c.cierrePromedioDias).toBe(10);
    });

    test('solo ganados: un abierto o perdido con stageChangedAt no entra', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-05T12:00:00Z') }); // 4 días
      await lead({ pipelineStage: 'contacted', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-30T12:00:00Z') });
      await lead({ pipelineStage: 'lost', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-30T12:00:00Z') });
      expect((await contadores()).cierrePromedioDias).toBe(4);
    });

    test('una fecha de cierre anterior a la creación (dato raro) cuenta como 0 días, nunca negativo', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-10T12:00:00Z'), stageChangedAt: D('2026-09-01T12:00:00Z') });
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') }); // 10
      expect((await contadores()).cierrePromedioDias).toBe(5); // (0 + 10) / 2
    });

    test('sin ningún ganado con fecha: null (no 0)', async () => {
      await lead({ pipelineStage: 'won' });
      await lead({ pipelineStage: 'new' });
      expect((await contadores()).cierrePromedioDias).toBeNull();
    });
  });

  describe('pipeline propio: las etapas ganada/perdida de CADA lead, no un «won» fijo', () => {
    test('cerrados y tasa usan las etapas isWon del pipeline del lead', async () => {
      const propio = await Pipeline.create({
        business: negocio._id, name: 'Propio', isDefault: false,
        stages: [
          { key: 'consulta', name: 'Consulta', order: 1, color: '#111111' },
          { key: 'reservado', name: 'Reservado', order: 2, color: '#222222', isWon: true },
          { key: 'descartado', name: 'Descartado', order: 3, color: '#333333', isLost: true },
        ],
      });
      const enPropio = (extra) => lead(extra, negocio._id, propio._id);
      await enPropio({ pipelineStage: 'consulta' });
      await enPropio({ pipelineStage: 'reservado', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-07T12:00:00Z') }); // ganado: 6 días
      await enPropio({ pipelineStage: 'descartado' });
      await enPropio({ pipelineStage: 'won' }); // «won» no existe en este pipeline: no es un ganado
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') }); // ganado del por defecto: 10 días

      const c = await contadores();

      expect(c.leads).toBe(5);
      expect(c.cerrados).toBe(2);
      expect(c.tasaDeCierre).toBe(40);
      expect(c.cierrePromedioDias).toBe(8); // (6 + 10) / 2
    });

    test('un lead sin pipeline o con uno inactivo se mira contra el pipeline por defecto', async () => {
      const inactivo = await Pipeline.create({ business: negocio._id, name: 'Viejo', isActive: false, stages: [{ key: 'x', name: 'X', order: 1, color: '#111111', isWon: true }] });
      await Lead.collection.insertOne({ business: negocio._id, name: 'Sin pipeline', pipelineStage: 'won', isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date() });
      await lead({ pipelineStage: 'won' }, negocio._id, inactivo._id);
      expect((await contadores()).cerrados).toBe(2);
    });
  });

  describe('periodo y zona horaria', () => {
    test('los contadores son de todo el historial: el periodo elegido NO los cambia', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-08-20T12:00:00Z'), stageChangedAt: D('2026-08-25T12:00:00Z') });
      await lead({ createdAt: D('2026-10-02T12:00:00Z'), temperature: 'hot' });

      const esteMes = await contadores({ period: 'this_month' });
      const mesPasado = await contadores({ period: 'last_month' });
      const personalizado = await contadores({ period: 'custom', from: '2026-10-01', to: '2026-10-05' });

      expect(esteMes).toEqual(mesPasado);
      expect(esteMes).toEqual(personalizado);
      expect(esteMes).toMatchObject({ leads: 2, cerrados: 1, calientes: 1 });
    });

    test('un lead creado en el borde de mes de Lima (04:59Z del 1 de octubre = 30 de septiembre) cuenta igual', async () => {
      await lead({ createdAt: D('2026-10-01T04:59:00Z') });
      await lead({ createdAt: D('2026-10-01T05:01:00Z') });
      expect((await contadores({ period: 'last_month' })).leads).toBe(2);
      expect((await contadores({ period: 'this_month' })).leads).toBe(2);
    });

    test('el cierre promedio mide tiempo transcurrido (24 h = 1 día), no días de calendario: no depende de la zona', async () => {
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T04:00:00Z'), stageChangedAt: D('2026-09-02T04:00:00Z') });
      const lima = (await contadores()).cierrePromedioDias;

      const utc = await Business.create({ name: 'Zona UTC', country: 'PE', settings: { timezone: 'UTC' } });
      const pu = await Pipeline.createDefault(utc._id, actor);
      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T04:00:00Z'), stageChangedAt: D('2026-09-02T04:00:00Z') }, utc._id, pu._id);

      expect(lima).toBe(1);
      expect((await contadores({}, utc._id)).cierrePromedioDias).toBe(1);
    });
  });

  describe('aislamiento entre negocios', () => {
    test('cada negocio cuenta solo lo suyo', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' });
      const pOtro = await Pipeline.createDefault(otro._id, actor);

      await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-11T12:00:00Z') });
      await lead({ temperature: 'hot' });
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await lead({ pipelineStage: 'won', createdAt: D('2026-09-01T12:00:00Z'), stageChangedAt: D('2026-09-02T12:00:00Z') }, otro._id, pOtro._id);
      }
      await lead({ temperature: 'hot' }, otro._id, pOtro._id);

      const mio = await contadores();
      const suyo = await contadores({}, otro._id);

      expect(mio).toMatchObject({ leads: 2, cerrados: 1, calientes: 1, cierrePromedioDias: 10 });
      expect(suyo).toMatchObject({ leads: 5, cerrados: 4, calientes: 1, cierrePromedioDias: 1 });
    });
  });
});
