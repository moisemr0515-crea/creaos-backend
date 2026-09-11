// Test real (Jest, commiteado) de lead.service.js#listarLeads() — cobertura
// de paginación (backlog "Buscador de leads + paginación de Pipeline", sep/
// 2026). No existía ningún test de este método hasta ahora — el frontend
// (crea-os-ignite) nunca mandaba page/limit, así que Pipeline/Leads
// quedaban topeados en los primeros 20 leads del negocio sin ningún
// indicio de que hubiera más. Este archivo prueba el contrato exacto que
// el frontend ahora consume: page/limit/total/totalPages.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('./lead.model');
const { listarLeads } = require('./lead.service');
const { listLeads } = require('./lead.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_service_listarleads';

describe('lead.service#listarLeads() — paginación', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Lead.init(); // el índice de texto tarda en construirse, ver channelOnboardingSession.model.test.js para el mismo criterio
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearLeads = (cantidad) => {
    const docs = [];
    for (let i = 0; i < cantidad; i += 1) {
      // createdAt espaciado explícito (no Date.now() repetido) — sortBy
      // default es createdAt:desc, así que el orden tiene que ser
      // determinístico para poder aserter "los últimos 20" sin flakiness.
      docs.push({
        business: business._id,
        name: `Lead ${String(i).padStart(3, '0')}`,
        phone: `+5199900${String(i).padStart(4, '0')}`,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    return Lead.insertMany(docs);
  };

  test('negocio con 25 leads: page 1 (default) devuelve 20, total:25, totalPages:2', async () => {
    await crearLeads(25);

    const { leads, total } = await listarLeads(business._id, {}, null, false);

    expect(leads).toHaveLength(20);
    expect(total).toBe(25);
  });

  test('page 2 (limit default 20) devuelve los 5 restantes, sin solaparse con la página 1', async () => {
    await crearLeads(25);

    const pagina1 = await listarLeads(business._id, { page: 1, limit: 20 }, null, false);
    const pagina2 = await listarLeads(business._id, { page: 2, limit: 20 }, null, false);

    expect(pagina1.leads).toHaveLength(20);
    expect(pagina2.leads).toHaveLength(5);
    expect(pagina2.total).toBe(25);

    const idsPagina1 = new Set(pagina1.leads.map((l) => String(l._id)));
    const idsPagina2 = pagina2.leads.map((l) => String(l._id));
    for (const id of idsPagina2) {
      expect(idsPagina1.has(id)).toBe(false);
    }

    // Juntas, las 2 páginas cubren el total real — ningún lead se pierde ni se repite.
    expect(idsPagina1.size + idsPagina2.length).toBe(25);
  });

  test('negocio con 15 leads (menos del límite de página): page 1 los devuelve todos, sin página 2', async () => {
    await crearLeads(15);

    const { leads, total } = await listarLeads(business._id, {}, null, false);

    expect(leads).toHaveLength(15);
    expect(total).toBe(15);
  });

  test('limit explícito distinto de 20 se respeta', async () => {
    await crearLeads(25);

    const { leads, total } = await listarLeads(business._id, { page: 1, limit: 10 }, null, false);

    expect(leads).toHaveLength(10);
    expect(total).toBe(25); // el total real no depende del limit pedido
  });
});

// Filtro `pipeline` (backlog "buscador + paginación real del Kanban", PR A)
// — acota `stage` a UN pipeline específico. Necesario para que el "ver más"
// por columna del Kanban no mezcle leads de 2 pipelines del mismo negocio
// que compartan una stage.key (ver el comentario en listLeadsSchema).
describe('lead.service#listarLeads() — filtro pipeline', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
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
  });

  const STAGES = [{ key: 'nuevo', name: 'Nuevo', order: 1, isWon: false, isLost: false }];

  test('con `pipeline`: solo devuelve leads de ESE pipeline, aunque otro comparta la misma stage.key', async () => {
    const pipelineA = await Pipeline.create({ business: business._id, name: 'Pipeline A', stages: STAGES, isDefault: true, isActive: true });
    const pipelineB = await Pipeline.create({ business: business._id, name: 'Pipeline B', stages: STAGES, isActive: true });

    await Lead.create({ business: business._id, name: 'Lead de A', pipeline: pipelineA._id, pipelineStage: 'nuevo' });
    await Lead.create({ business: business._id, name: 'Lead de B', pipeline: pipelineB._id, pipelineStage: 'nuevo' });

    const { leads, total } = await listarLeads(business._id, { stage: 'nuevo', pipeline: pipelineA._id.toString() }, null, false);

    expect(total).toBe(1);
    expect(leads[0].name).toBe('Lead de A');
  });

  test('sin `pipeline`: sigue devolviendo leads de todos los pipelines que matcheen el resto de los filtros (sin regresión)', async () => {
    const pipelineA = await Pipeline.create({ business: business._id, name: 'Pipeline A', stages: STAGES, isDefault: true, isActive: true });
    const pipelineB = await Pipeline.create({ business: business._id, name: 'Pipeline B', stages: STAGES, isActive: true });

    await Lead.create({ business: business._id, name: 'Lead de A', pipeline: pipelineA._id, pipelineStage: 'nuevo' });
    await Lead.create({ business: business._id, name: 'Lead de B', pipeline: pipelineB._id, pipelineStage: 'nuevo' });

    const { total } = await listarLeads(business._id, { stage: 'nuevo' }, null, false);

    expect(total).toBe(2);
  });
});

// Nivel HTTP — confirma que meta.{page,limit,total,totalPages} llega tal
// cual al response que consume crea-os-ignite (listLeadsPage(), leads.ts).
// lead.controller.js#listLeads() es solo un pasamanos (validateQuery +
// llamar al service de arriba + buildMeta()) — este test cubre exactamente
// ese cableado, no vuelve a probar la lógica de paginación en sí.
describe('lead.controller#listLeads() — shape de meta en la respuesta HTTP', () => {
  let business;
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };
  const requester = { _id: new mongoose.Types.ObjectId(), role: { slug: 'owner', permissions: ['leads:read'] } };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    const docs = [];
    for (let i = 0; i < 25; i += 1) {
      docs.push({ business: business._id, name: `Lead ${i}`, createdAt: new Date(Date.now() + i * 1000) });
    }
    await Lead.insertMany(docs);
  });

  test('GET /leads?page=2&limit=20 devuelve meta.total=25, meta.totalPages=2, meta.page=2, y los 5 leads restantes', async () => {
    const req = { businessId: business._id, user: requester, query: { page: '2', limit: '20' } };
    const res = mockRes();
    const next = jest.fn();

    await listLeads(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.leads).toHaveLength(5);
    expect(body.meta).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
  });
});
