// Test real (Jest) de scripts/ensure-atlas-vector-indexes.js — Bloque 3 de
// la auditoría Business Brain (§51/§53, 20/sep/2026). createSearchIndex()/
// listSearchIndexes()/updateSearchIndex() son comandos de Atlas, no
// soportados por un Mongo standalone local (confirmado en la Fase 1 de
// este bloque) — así que acá se mockea la colección entera, a diferencia
// de los demás scripts de migración de este repo que sí corren contra
// Mongo local real. El cutover transaccional (pdfIngestion.service.js) sí
// se verificó contra Atlas real por separado (empíricamente, no en este
// suite) — y este script en sí también: correrlo contra producción reveló
// un bug real (scope.appliesToAll/productIds/channelIds sin declarar como
// filter), que es justamente lo que cubre la sección de "actualiza si la
// definición cambió" de acá abajo.
const { run, DEFINICIONES } = require('./ensure-atlas-vector-indexes');

// Simula el shape real de un índice YA existente con la definición
// correcta — Atlas devuelve `latestDefinition`, no `definition`.
const existenteConDefinicionCorrecta = (nombreIndice) => {
  const { definition } = DEFINICIONES.find((d) => d.nombreIndice === nombreIndice);
  return { name: nombreIndice, latestDefinition: definition };
};

function fakeDb({ indicesExistentes = [] } = {}) {
  const listSearchIndexes = jest.fn().mockReturnValue({ toArray: () => Promise.resolve(indicesExistentes) });
  const createSearchIndex = jest.fn().mockResolvedValue(undefined);
  const updateSearchIndex = jest.fn().mockResolvedValue(undefined);
  const collection = jest.fn().mockReturnValue({ listSearchIndexes, createSearchIndex, updateSearchIndex });
  return { db: { collection }, collection, listSearchIndexes, createSearchIndex, updateSearchIndex };
}

describe('ensure-atlas-vector-indexes', () => {
  test('define los 3 índices esperados (chunks + policies + faqs), con embedding/dimensión/similarity consistentes', () => {
    expect(DEFINICIONES.map((d) => d.coleccion).sort()).toEqual(['businessdocumentchunks', 'faqs', 'policies']);
    for (const { definition } of DEFINICIONES) {
      const campoVector = definition.fields.find((f) => f.type === 'vector');
      expect(campoVector).toEqual({ type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' });
    }
  });

  // Hallazgo real (20/sep/2026, verificado contra Atlas de producción):
  // buscarConocimiento() siempre arma el filtro de $vectorSearch con un
  // $or sobre scope.appliesToAll/productIds/channelIds — sin declarar esos
  // 3 campos como `filter` en el índice, Atlas rechaza la query ENTERA
  // ("needs to be indexed as filter"), y el retrieval semántico de
  // Policy/FAQ queda permanentemente inactivo (cae al fallback de solo
  // texto siempre, en silencio).
  test('policy_vector_index y faq_vector_index declaran los campos de scope que buscarConocimiento() realmente filtra', () => {
    const policyFields = DEFINICIONES.find((d) => d.nombreIndice === 'policy_vector_index').definition.fields.map((f) => f.path);
    const faqFields = DEFINICIONES.find((d) => d.nombreIndice === 'faq_vector_index').definition.fields.map((f) => f.path);

    expect(policyFields).toEqual(expect.arrayContaining(['scope.appliesToAll', 'scope.productIds', 'scope.channelIds']));
    expect(faqFields).toEqual(expect.arrayContaining(['scope.appliesToAll', 'scope.channelIds']));
    expect(faqFields).not.toContain('scope.productIds'); // FAQ.scope V1 no tiene productIds propio
  });

  test('dry-run (default): no llama a createSearchIndex ni updateSearchIndex en ninguna colección', async () => {
    const { db, createSearchIndex, updateSearchIndex } = fakeDb();

    const resultados = await run(db);

    expect(createSearchIndex).not.toHaveBeenCalled();
    expect(updateSearchIndex).not.toHaveBeenCalled();
    expect(resultados.every((r) => r.accion === 'pendiente_de_crear')).toBe(true);
  });

  test('--confirm (confirm:true): crea los 3 índices que faltan, con su definition exacta', async () => {
    const { db, createSearchIndex } = fakeDb();

    const resultados = await run(db, { confirm: true });

    expect(createSearchIndex).toHaveBeenCalledTimes(3);
    expect(createSearchIndex).toHaveBeenCalledWith(expect.objectContaining({ name: 'chunk_vector_index', type: 'vectorSearch' }));
    expect(resultados.every((r) => r.accion === 'creado')).toBe(true);
  });

  test('idempotente: un índice que YA existe con la definición correcta se saltea, incluso con --confirm', async () => {
    const { db, createSearchIndex, updateSearchIndex } = fakeDb({
      indicesExistentes: [existenteConDefinicionCorrecta('chunk_vector_index')],
    });

    const resultados = await run(db, { confirm: true });

    expect(createSearchIndex).toHaveBeenCalledTimes(2); // policy + faq, no chunk
    expect(updateSearchIndex).not.toHaveBeenCalled();
    expect(resultados.find((r) => r.nombreIndice === 'chunk_vector_index').accion).toBe('ya_existia');
  });

  test('todos ya existen con la definición correcta: --confirm no crea ni actualiza nada', async () => {
    const { db, createSearchIndex, updateSearchIndex } = fakeDb({
      indicesExistentes: DEFINICIONES.map((d) => existenteConDefinicionCorrecta(d.nombreIndice)),
    });

    const resultados = await run(db, { confirm: true });

    expect(createSearchIndex).not.toHaveBeenCalled();
    expect(updateSearchIndex).not.toHaveBeenCalled();
    expect(resultados.every((r) => r.accion === 'ya_existia')).toBe(true);
  });

  describe('índice existente con una definición DISTINTA a la esperada (self-healing del bug real de scope)', () => {
    const existenteConDefinicionVieja = () => ({
      name: 'policy_vector_index',
      latestDefinition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
          { type: 'filter', path: 'business' },
          { type: 'filter', path: 'status' },
          // Sin los campos de scope — la definición vieja, rota.
        ],
      },
    });

    test('dry-run: lo reporta como "pendiente_de_actualizar", no llama a updateSearchIndex', async () => {
      const { db, updateSearchIndex } = fakeDb({ indicesExistentes: [existenteConDefinicionVieja()] });

      const resultados = await run(db, { confirm: false });

      expect(updateSearchIndex).not.toHaveBeenCalled();
      expect(resultados.find((r) => r.nombreIndice === 'policy_vector_index').accion).toBe('pendiente_de_actualizar');
    });

    test('--confirm: llama a updateSearchIndex con la definición nueva completa (incluidos los campos de scope)', async () => {
      const { db, updateSearchIndex, createSearchIndex } = fakeDb({ indicesExistentes: [existenteConDefinicionVieja()] });

      const resultados = await run(db, { confirm: true });

      expect(updateSearchIndex).toHaveBeenCalledWith(
        'policy_vector_index',
        expect.objectContaining({ fields: expect.arrayContaining([{ type: 'filter', path: 'scope.appliesToAll' }]) })
      );
      expect(createSearchIndex).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'policy_vector_index' })); // update, no create
      expect(resultados.find((r) => r.nombreIndice === 'policy_vector_index').accion).toBe('actualizado');
    });
  });

  test('si listSearchIndexes().toArray() falla (colección todavía no existe): no revienta, lo trata como "sin índices todavía"', async () => {
    // Mismo shape que el driver real: listSearchIndexes() devuelve un
    // cursor de forma síncrona, el error real llega al await .toArray().
    const collection = jest.fn().mockReturnValue({
      listSearchIndexes: jest.fn().mockReturnValue({ toArray: () => Promise.reject(new Error('ns not found')) }),
      createSearchIndex: jest.fn().mockResolvedValue(undefined),
      updateSearchIndex: jest.fn().mockResolvedValue(undefined),
    });

    const resultados = await run({ collection }, { confirm: false });

    expect(resultados.every((r) => r.accion === 'pendiente_de_crear')).toBe(true);
  });
});
