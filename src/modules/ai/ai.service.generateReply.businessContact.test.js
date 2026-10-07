const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_business_contact';

const completionFinal = (content) => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const crearTurno = async ({ businessData, question, reply }) => {
  const business = await Business.create({ name: 'Negocio de prueba', ...businessData });
  const lead = await Lead.create({ business: business._id, name: 'Lead de prueba' });
  const conversation = await Conversation.create({
    business: business._id,
    lead: lead._id,
    channel: 'whatsapp',
    messages: [{ role: 'user', content: question, sentBy: 'lead' }],
  });
  const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create')
    .mockResolvedValueOnce(completionFinal(reply));

  const result = await aiService.generateReply(conversation._id, business, lead);
  const systemPrompt = createSpy.mock.calls[0][0].messages[0].content;
  createSpy.mockRestore();
  return { result, systemPrompt };
};

describe('ai.service#generateReply() — contacto digital autoritativo del tenant', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
  });

  test('website estructurado gana aunque el PDF contenga una URL histórica distinta', async () => {
    const { result, systemPrompt } = await crearTurno({
      businessData: {
        website: 'https://creaosapp.com',
        pdfSummary: 'El sitio histórico era https://creaemprendedores.com',
      },
      question: '¿Cuál es su página web?',
      reply: 'Nuestra página web es https://creaosapp.com',
    });

    expect(result.reply).toBe('Nuestra página web es https://creaosapp.com');
    expect(systemPrompt).toMatch(/CONTACTO DIGITAL OFICIAL DEL NEGOCIO ACTUAL/);
    expect(systemPrompt).toMatch(/Sitio web: https:\/\/creaosapp\.com/);
    expect(systemPrompt).toMatch(/Estos valores tienen prioridad sobre el PDF\/documento/);
    expect(systemPrompt).toMatch(/para sitio web, redes sociales o contacto digital no uses esta herramienta/);
  });

  test('Facebook, Instagram y TikTok se entregan exactamente como están configurados al pedir las redes', async () => {
    const facebookUrl = 'https://facebook.com/tenant-oficial';
    const instagramUrl = 'https://instagram.com/tenant_oficial';
    const tiktokUrl = 'https://tiktok.com/@tenant_oficial';
    const { result, systemPrompt } = await crearTurno({
      businessData: { facebookUrl, instagramUrl, tiktokUrl },
      question: 'Pásame tus redes sociales',
      reply: `${facebookUrl}\n${instagramUrl}\n${tiktokUrl}`,
    });

    expect(result.reply).toBe(`${facebookUrl}\n${instagramUrl}\n${tiktokUrl}`);
    expect(systemPrompt).toContain(`- Facebook: ${facebookUrl}`);
    expect(systemPrompt).toContain(`- Instagram: ${instagramUrl}`);
    expect(systemPrompt).toContain(`- TikTok: ${tiktokUrl}`);
    expect(systemPrompt).toMatch(/usa exclusivamente los valores configurados de este bloque/);
    expect(systemPrompt).toMatch(/conserva cada URL exactamente como aparece/);
  });

  test('dos tenants consecutivos reciben solo sus propias URLs', async () => {
    const turnoA = await crearTurno({
      businessData: {
        website: 'https://tenant-a.example',
        instagramUrl: 'https://instagram.com/tenant_a',
      },
      question: '¿Cuál es su web e Instagram?',
      reply: 'https://tenant-a.example https://instagram.com/tenant_a',
    });
    const turnoB = await crearTurno({
      businessData: {
        website: 'https://tenant-b.example',
        instagramUrl: 'https://instagram.com/tenant_b',
      },
      question: '¿Cuál es su web e Instagram?',
      reply: 'https://tenant-b.example https://instagram.com/tenant_b',
    });

    expect(turnoA.systemPrompt).toContain('https://tenant-a.example');
    expect(turnoA.systemPrompt).toContain('https://instagram.com/tenant_a');
    expect(turnoA.systemPrompt).not.toContain('https://tenant-b.example');
    expect(turnoA.systemPrompt).not.toContain('https://instagram.com/tenant_b');
    expect(turnoB.systemPrompt).toContain('https://tenant-b.example');
    expect(turnoB.systemPrompt).toContain('https://instagram.com/tenant_b');
    expect(turnoB.systemPrompt).not.toContain('https://tenant-a.example');
    expect(turnoB.systemPrompt).not.toContain('https://instagram.com/tenant_a');
  });

  test('campo vacío no inventa ni adopta como fallback una URL del PDF', async () => {
    const { result, systemPrompt } = await crearTurno({
      businessData: {
        pdfSummary: 'Documento histórico: visita https://creaemprendedores.com',
      },
      question: '¿Cuál es su página web?',
      reply: 'El sitio web no está configurado actualmente.',
    });

    expect(result.reply).toBe('El sitio web no está configurado actualmente.');
    expect(systemPrompt).toMatch(/Sitio web: NO CONFIGURADO/);
    expect(systemPrompt).toMatch(/Facebook: NO CONFIGURADO/);
    expect(systemPrompt).toMatch(/Instagram: NO CONFIGURADO/);
    expect(systemPrompt).toMatch(/TikTok: NO CONFIGURADO/);
    expect(systemPrompt).toMatch(/Si un canal figura como NO CONFIGURADO, indica que no está disponible/);
    expect(systemPrompt).toMatch(/nunca inventes una URL/);
  });
});
