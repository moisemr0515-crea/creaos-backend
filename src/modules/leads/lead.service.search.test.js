// Test real (Jest, Mongo real) de lead.service.js#listarLeads() — búsqueda
// (search). Cubre el fix del hallazgo "el buscador de leads no encuentra
// coincidencias parciales de teléfono": $text indexa por palabras
// completas, un teléfono es un solo token largo sin espacios, así que
// buscar "922" nunca matchea "+51922800127" por $text — ver
// aplicarFiltroDeBusqueda()/buscarPorTelefono() en lead.service.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('./lead.model');
const { listarLeads } = require('./lead.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_service_search';

describe('lead.service#listarLeads() — search', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Lead.init(); // el índice de texto tarda en construirse, ver lead.service.listarLeads.test.js
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

  test('substring de teléfono matchea — el bug original: "922" encuentra "+51922800127"', async () => {
    await Lead.create({ business: business._id, name: 'Juan Pérez', phone: '+51922800127' });
    await Lead.create({ business: business._id, name: 'Otro Lead', phone: '+51900922111' });

    const { leads, total } = await listarLeads(business._id, { search: '922' }, null, false);

    // Ojo: "922" también es substring de "+51900922111" en el medio — ambos matchean, es correcto.
    expect(total).toBe(2);
    expect(leads.map((l) => l.name).sort()).toEqual(['Juan Pérez', 'Otro Lead']);
  });

  test('búsqueda por nombre sigue funcionando vía $text (palabra completa)', async () => {
    await Lead.create({ business: business._id, name: 'María García', phone: '+51911111111' });
    await Lead.create({ business: business._id, name: 'Pedro López', phone: '+51922222222' });

    const { leads, total } = await listarLeads(business._id, { search: 'García' }, null, false);

    expect(total).toBe(1);
    expect(leads[0].name).toBe('María García');
  });

  test('el término de búsqueda de teléfono se limpia de separadores antes de buscar', async () => {
    await Lead.create({ business: business._id, name: 'Lead con espacios', phone: '+51922800127' });

    const { leads, total } = await listarLeads(business._id, { search: '922 800 127' }, null, false);

    expect(total).toBe(1);
    expect(leads[0].phone).toBe('+51922800127');
  });

  test('un lead que matchea por nombre Y por teléfono no aparece duplicado', async () => {
    // "922" aparece tanto en el nombre (casual, no debería pasar en la práctica) como en el teléfono.
    await Lead.create({ business: business._id, name: 'Lead 922', phone: '+51922800127' });

    const { leads, total } = await listarLeads(business._id, { search: '922' }, null, false);

    expect(total).toBe(1);
    expect(leads).toHaveLength(1);
  });

  test('caracteres especiales de regex en el término no rompen la query ni matchean de más', async () => {
    await Lead.create({ business: business._id, name: 'Lead normal', phone: '+51922800127' });

    // "(999)" no tiene dígitos que sobrevivan al $&/limpieza salvo "999" — no debería matchear nada,
    // y sobre todo no debería tirar una excepción por la regex mal formada.
    await expect(listarLeads(business._id, { search: '(999)+*' }, null, false)).resolves.toEqual({
      leads: [],
      total: 0,
    });
  });

  test('búsqueda sin resultados en ninguno de los 2 criterios devuelve vacío, no un error', async () => {
    await Lead.create({ business: business._id, name: 'Lead cualquiera', phone: '+51922800127' });

    const { leads, total } = await listarLeads(business._id, { search: 'noexiste' }, null, false);

    expect(total).toBe(0);
    expect(leads).toHaveLength(0);
  });

  test('respeta el resto de los filtros (ej. stage) combinados con search', async () => {
    await Lead.create({ business: business._id, name: 'Lead activo', phone: '+51922800127', pipelineStage: 'new' });
    await Lead.create({ business: business._id, name: 'Lead ganado', phone: '+51922800128', pipelineStage: 'won' });

    const { leads, total } = await listarLeads(business._id, { search: '922', stage: 'new' }, null, false);

    expect(total).toBe(1);
    expect(leads[0].name).toBe('Lead activo');
  });
});
