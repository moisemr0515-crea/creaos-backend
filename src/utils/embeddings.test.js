// Test real de src/utils/embeddings.js — Bloque 3 de la auditoría Business
// Brain (§45-56, 20/sep/2026). Mismo criterio que
// business.service.subirPdf.test.js: se espía sobre el cliente `openai`
// real exportado por el propio módulo, sin pegarle a la red.
const { generarEmbeddings, generarEmbedding, openai } = require('./embeddings');

describe('generarEmbeddings()', () => {
  afterEach(() => jest.restoreAllMocks());

  test('array vacío: no llama a la API, devuelve array vacío', async () => {
    const spy = jest.spyOn(openai.embeddings, 'create');

    const resultado = await generarEmbeddings([]);

    expect(resultado).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test('una sola llamada batch para varios textos, en el mismo orden de la respuesta', async () => {
    const spy = jest.spyOn(openai.embeddings, 'create').mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    });

    const resultado = await generarEmbeddings(['texto uno', 'texto dos']);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ input: ['texto uno', 'texto dos'] }));
    expect(resultado).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  test('usa OPENAI_EMBEDDING_MODEL (no un modelo de chat)', async () => {
    const spy = jest.spyOn(openai.embeddings, 'create').mockResolvedValue({ data: [{ embedding: [0.1] }] });

    await generarEmbeddings(['x']);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ model: 'text-embedding-3-small' }));
  });
});

describe('generarEmbedding() (conveniencia de un solo texto)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('devuelve el embedding único, no un array de arrays', async () => {
    jest.spyOn(openai.embeddings, 'create').mockResolvedValue({ data: [{ embedding: [0.9, 0.8] }] });

    const resultado = await generarEmbedding('una query cualquiera');

    expect(resultado).toEqual([0.9, 0.8]);
  });
});
