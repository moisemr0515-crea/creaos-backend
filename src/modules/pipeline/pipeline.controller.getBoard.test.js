// Test real (Jest, Mongo real) de pipeline.controller.js#getBoard() — nivel
// HTTP. obtenerTablero() en sí (search, $topN, hasMore, avgCloseProbability)
// ya está probado a fondo en pipeline.service.obtenerTablero.test.js — este
// archivo solo confirma el cableado: que `req.query.search` llega tal cual
// al service (validateQuery + Joi), mismo criterio que el test HTTP de
// lead.controller#listLeads() (lead.service.listarLeads.test.js).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('./pipeline.model');
const Lead = require('../leads/lead.model');
const { getBoard } = require('./pipeline.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_pipeline_controller_getboard';

describe('pipeline.controller#getBoard() — cableado de search vía HTTP', () => {
  let business;
  let pipeline;
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Lead.init();
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
    pipeline = await Pipeline.create({
      business: business._id,
      name: 'Pipeline',
      stages: [{ key: 'nuevo', name: 'Nuevo', order: 1, isWon: false, isLost: false }],
      isDefault: true,
      isActive: true,
    });
  });

  test('sin search: devuelve el tablero completo, sin filtrar', async () => {
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Cualquiera' });
    const req = { businessId: business._id, params: { id: pipeline._id.toString() }, query: {} };
    const res = mockRes();
    const next = jest.fn();

    await getBoard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.data.tablero.find((c) => c.stage === 'nuevo').count).toBe(1);
  });

  test('?search=922 llega hasta obtenerTablero() y filtra el tablero', async () => {
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'María', phone: '+51922800127' });
    await Lead.create({ business: business._id, pipeline: pipeline._id, pipelineStage: 'nuevo', name: 'Pedro', phone: '+51900111000' });

    const req = { businessId: business._id, params: { id: pipeline._id.toString() }, query: { search: '922' } };
    const res = mockRes();
    const next = jest.fn();

    await getBoard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    const columnaNuevo = body.data.tablero.find((c) => c.stage === 'nuevo');
    expect(columnaNuevo.count).toBe(1);
    expect(columnaNuevo.leads[0].name).toBe('María');
  });

  test('search más largo que el límite (200) se rechaza con next(err), no rompe el request', async () => {
    const req = { businessId: business._id, params: { id: pipeline._id.toString() }, query: { search: 'x'.repeat(201) } };
    const res = mockRes();
    const next = jest.fn();

    await getBoard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
