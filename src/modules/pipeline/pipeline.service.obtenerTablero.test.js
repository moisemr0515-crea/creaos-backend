// Test real (Jest, Mongo real) de pipeline.service.js#obtenerTablero() —
// backlog "buscador + paginación real del Kanban", PR B/5. No existía
// NINGÚN test de este módulo hasta ahora (obtenerTablero() no se usaba
// desde ningún frontend, quedó sin cobertura). Cubre el corte a 7 leads
// por columna vía $topN, hasMore, avgCloseProbability (mismo criterio que
// probability() en crea-os-ignite/src/lib/lead-finance.ts) y el filtro
// search opcional (reusa lead.search.js, ya probado aparte en
// lead.service.search.test.js — acá solo se confirma el wiring).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('./pipeline.model');
const Lead = require('../leads/lead.model');
const { obtenerTablero } = require('./pipeline.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_pipeline_obtenertablero';

describe('pipeline.service#obtenerTablero()', () => {
  let business;
  let pipeline;

  const STAGES = [
    { key: 'nuevo', name: 'Nuevo', order: 1, isWon: false, isLost: false },
    { key: 'ganado', name: 'Ganado', order: 2, isWon: true, isLost: false },
  ];

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Lead.init(); // el índice de texto tarda en construirse, ver lead.service.listarLeads.test.js
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    pipeline = await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES, isDefault: true, isActive: true });
  });

  const crearLeads = (cantidad, overrides = {}) => {
    const docs = [];
    for (let i = 0; i < cantidad; i += 1) {
      docs.push({
        business: business._id,
        pipeline: pipeline._id,
        pipelineStage: 'nuevo',
        name: `Lead ${String(i).padStart(3, '0')}`,
        potentialValue: 100,
        createdAt: new Date(Date.now() + i * 1000), // orden determinístico, mismo criterio que lead.service.listarLeads.test.js
        ...overrides,
      });
    }
    return Lead.insertMany(docs);
  };

  test('columna con 10 leads: el tablero trae solo los primeros 7 (los más recientes), pero count sigue siendo 10', async () => {
    await crearLeads(10);

    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(columnaNuevo.leads).toHaveLength(7);
    expect(columnaNuevo.count).toBe(10);
    // $topN ordena por createdAt desc — los 7 visibles son los últimos creados (009..003).
    expect(columnaNuevo.leads.map((l) => l.name)).toEqual([
      'Lead 009', 'Lead 008', 'Lead 007', 'Lead 006', 'Lead 005', 'Lead 004', 'Lead 003',
    ]);
  });

  test('hasMore:true cuando hay más de 7, hasMore:false cuando no', async () => {
    await crearLeads(10);
    const { tablero: tableroConMas } = await obtenerTablero(business._id, pipeline._id);
    expect(tableroConMas.find((c) => c.stage === 'nuevo').hasMore).toBe(true);

    await Lead.deleteMany({});
    await crearLeads(5);
    const { tablero: tableroSinMas } = await obtenerTablero(business._id, pipeline._id);
    expect(tableroSinMas.find((c) => c.stage === 'nuevo').hasMore).toBe(false);
  });

  test('totalValue suma TODOS los leads de la columna, no solo los 7 visibles', async () => {
    await crearLeads(10, { potentialValue: 50 });

    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(columnaNuevo.totalValue).toBe(500); // 10 * 50, no 7 * 50
  });

  test('leads incluye lastContactedAt — necesario para la alerta "sin respuesta" de la tarjeta del Kanban (frontend)', async () => {
    const hace3dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Con contacto', lastContactedAt: hace3dias });

    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(new Date(columnaNuevo.leads[0].lastContactedAt).getTime()).toBe(hace3dias.getTime());
  });

  test('avgCloseProbability: usa closeProbability explícito cuando existe', async () => {
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'A', closeProbability: 80 });
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'B', closeProbability: 40 });

    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(columnaNuevo.avgCloseProbability).toBe(60); // (80+40)/2
  });

  test('avgCloseProbability: sin closeProbability, usa el fallback por temperatura (mismo criterio que lead-finance.ts)', async () => {
    // closeProbability:null explícito — el default:0 del schema NO aplica sobre un valor ya seteado a null.
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Frío', temperature: 'cold', closeProbability: null });
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Caliente', temperature: 'hot', closeProbability: null });

    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(columnaNuevo.avgCloseProbability).toBe(43); // (10 + 75) / 2 = 42.5 → redondeado a 43
  });

  test('columna sin ningún lead: count:0, leads:[], hasMore:false, avgCloseProbability:0 (no NaN)', async () => {
    const { tablero } = await obtenerTablero(business._id, pipeline._id);
    const columnaGanado = tablero.find((c) => c.stage === 'ganado');

    expect(columnaGanado).toEqual({
      stage: 'ganado',
      name: 'Ganado',
      color: undefined,
      order: 2,
      isWon: true,
      isLost: false,
      count: 0,
      totalValue: 0,
      avgCloseProbability: 0,
      hasMore: false,
      leads: [],
    });
  });

  test('search filtra el tablero con el mismo criterio que /leads (wiring — los casos de $text/$regex ya están probados en lead.service.search.test.js)', async () => {
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'María García', phone: '+51922800127' });
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Pedro López', phone: '+51900111000' });

    const { tablero } = await obtenerTablero(business._id, pipeline._id, '922');
    const columnaNuevo = tablero.find((c) => c.stage === 'nuevo');

    expect(columnaNuevo.count).toBe(1);
    expect(columnaNuevo.leads[0].name).toBe('María García');
  });
});
