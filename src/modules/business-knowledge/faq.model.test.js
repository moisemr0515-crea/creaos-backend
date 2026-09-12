// Test real (Jest, Mongo real) del modelo FAQ — CREA SALES AI™ C.2
// Business Brain: Policies + FAQ V1, Etapa 2/11. Cubre la normalización
// determinista de `question`→`normalizedQuestion` (documento §8), que el
// índice {business,normalizedQuestion} NO es único (decisión confirmada
// #4), el dedupe de aliases/keywords/tags, y las invariantes compartidas
// con Policy (vigencia).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const FAQ = require('./faq.model');
const { normalizarPregunta } = require('./faq.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_faq_model';

describe('FAQ (modelo)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await FAQ.init();
  });

  afterAll(async () => {
    await FAQ.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await FAQ.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const datosValidos = (overrides = {}) => ({
    business: business._id,
    question: '¿Aceptan Yape?',
    answer: 'Sí, aceptamos Yape, Plin y transferencia bancaria.',
    category: 'payments',
    ...overrides,
  });

  test('crea una FAQ válida con los defaults documentados', async () => {
    const faq = await FAQ.create(datosValidos());
    expect(faq.status).toBe('draft');
    expect(faq.priority).toBe(50);
    expect(faq.confidenceMode).toBe('normal');
    expect(faq.scope.appliesToAll).toBe(true);
    expect(faq.version).toBe(1);
  });

  test.each(['business', 'question', 'answer', 'category'])('%s es requerido', async (campo) => {
    const datos = datosValidos();
    delete datos[campo];
    await expect(FAQ.create(datos)).rejects.toThrow();
  });

  test('question debe tener al menos 3 caracteres', async () => {
    await expect(FAQ.create(datosValidos({ question: 'hi' }))).rejects.toThrow();
  });

  describe('normalizarPregunta() (documento §8)', () => {
    test.each([
      ['¿ACEPTAN Yape?', 'aceptan yape'],
      ['¿Dónde están ubicados?', 'donde estan ubicados'],
      ['  Hola   Mundo  ', 'hola mundo'],
      ['Cuesta 20% + S/ 50, dura 7 días, Modelo X200, 10x20 m', 'cuesta 20% + s/ 50, dura 7 dias, modelo x200, 10x20 m'],
    ])('normaliza %s → %s (tolera mayúsculas/acentos/signos, preserva números/%%/moneda/unidades)', (input, esperado) => {
      expect(normalizarPregunta(input)).toBe(esperado);
    });
  });

  test('normalizedQuestion se calcula automáticamente al crear', async () => {
    const faq = await FAQ.create(datosValidos({ question: '¿ACEPTAN Yape?' }));
    expect(faq.normalizedQuestion).toBe('aceptan yape');
  });

  test('normalizedQuestion se recalcula al editar la pregunta', async () => {
    const faq = await FAQ.create(datosValidos());
    faq.question = '¿Tienen Plin?';
    await faq.save();
    expect(faq.normalizedQuestion).toBe('tienen plin');
  });

  test('{business, normalizedQuestion} NO es único — 2 FAQs con la misma pregunta normalizada se guardan sin error (decisión confirmada #4)', async () => {
    await FAQ.create(datosValidos({ question: '¿Aceptan Yape?', answer: 'Respuesta vieja' }));
    const segunda = await FAQ.create(datosValidos({ question: 'aceptan yape', answer: 'Respuesta nueva, más completa' }));

    expect(segunda.normalizedQuestion).toBe('aceptan yape');
    expect(await FAQ.countDocuments({ business: business._id, normalizedQuestion: 'aceptan yape' })).toBe(2);
  });

  test('aliases/keywords/tags se dedupean', async () => {
    const faq = await FAQ.create(datosValidos({
      aliases: ['puedo pagar con yape', 'Puedo Pagar Con Yape', 'tienen yape'],
      keywords: ['pago', 'pago', 'yape'],
    }));
    expect(faq.aliases).toEqual(['puedo pagar con yape', 'tienen yape']);
    expect(faq.keywords).toEqual(['pago', 'yape']);
  });

  describe('vigencia (mismo invariante que Policy)', () => {
    test('effectiveUntil igual o anterior a effectiveFrom es inválido', async () => {
      await expect(FAQ.create(datosValidos({
        effectiveFrom: new Date('2026-12-31'),
        effectiveUntil: new Date('2026-01-01'),
      }))).rejects.toThrow(/effectiveUntil/);
    });
  });
});
