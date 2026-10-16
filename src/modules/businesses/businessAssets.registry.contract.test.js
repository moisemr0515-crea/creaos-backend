// FASE 3 / ETAPA C — CONTRATO ANTI-ROTURA de «Mi negocio» ↔ agente de IA (audit/28).
//
// El registro único (businessAssets.registry.js) declara qué LEE la IA (nunca se envía) y qué ENVÍA por WhatsApp.
// Este archivo es el contrato:
//   (c) estático: un campo nuevo de asset/conocimiento en el modelo, o una entrada del registro sin consumidor real,
//       rompe el test (obliga a registrar y a conectar).
//   (a) cada LEE tiene un consumidor REAL en el camino del agente y devuelve contenido para un negocio de prueba.
//   (b) cada ENVIA se resuelve a un mensaje de media del tipo correcto, por la tool real, hasta el payload de Gupshup.
//   (d) con 0 productos / 0 políticas / sin PDF la IA degrada sin error y dice qué falta; con datos los usa.
// Dos negocios (tenants) ficticios: nada es específico de un lead, teléfono o negocio.

// Credenciales FALSAS de Cloudinary (la firma de URLs es local, no hace red) — se fuerzan para no usar las del entorno.
process.env.CLOUDINARY_CLOUD_NAME = 'cloud-de-prueba';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'secreto-de-prueba';

jest.mock('../channels/queues/outbound.queue', () => ({ enqueueOutbound: jest.fn(), getOutboundQueue: jest.fn() }));
jest.mock('../../utils/embeddings', () => ({
  generarEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
  generarEmbeddings: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('./business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Conversation = require('../ai/conversation.model');
const OutboundEvent = require('../channels/outboundEvent.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const Policy = require('../business-knowledge/policy.model');
const FAQ = require('../business-knowledge/faq.model');
const BusinessDocumentChunk = require('../business-knowledge/businessDocumentChunk.model');
const { buildSystemPrompt } = require('../ai/ai.service');
const { TOOL_REGISTRY, executeToolCall } = require('../ai/tools');
const gupshupPartnerClient = require('../webhooks/gupshup.partner.client');
const registry = require('./businessAssets.registry');
const readiness = require('./businessReadiness.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_assets_contract';
const nombresDeTools = TOOL_REGISTRY.map((t) => t.name);

// ── (c) ESTÁTICO ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('contrato estático — nada se agrega sin registrar', () => {
  // Campos de Business que tienen que ver con material enviable o conocimiento de la IA.
  const RELEVANTE = /logo|photo|pdf|brochure|video|asset|instruction|personality/i;
  const camposDelModelo = Object.keys(Business.schema.paths).filter((p) => !p.includes('.') && RELEVANTE.test(p));

  test('todo campo de asset/conocimiento de Business está en el registro (CAMPOS_DE_BUSINESS) o excluido con motivo', () => {
    const sinRegistrar = camposDelModelo.filter((c) => !registry.CAMPOS_DE_BUSINESS[c] && !registry.NO_ALIMENTAN_A_LA_IA[c]);
    expect(sinRegistrar).toEqual([]); // si falla: registrá el campo nuevo en businessAssets.registry.js (LEE o ENVIA)
  });

  test('todo campo declarado en el registro existe de verdad en el modelo (sin typos ni campos fantasma)', () => {
    const declarados = [...Object.keys(registry.CAMPOS_DE_BUSINESS), ...Object.keys(registry.NO_ALIMENTAN_A_LA_IA)];
    expect(declarados.filter((c) => !Business.schema.path(c))).toEqual([]);
  });

  test('las fotos de producto (Product.mediaAssets) están registradas y son el único campo de media del modelo Product', () => {
    const camposDeMedia = Object.keys(Product.schema.paths).filter((p) => !p.includes('.') && /media|photo|image|asset/i.test(p));
    expect(camposDeMedia).toEqual(registry.ENVIA_DE_PRODUCTO.origin.fields);
    expect(registry.ENVIA_DE_PRODUCTO.consumer.name).toBe('send_product_photos');
  });

  test('el contrato fija las 5 secciones que la IA LEE y las 4 que ENVÍA (+ fotos del catálogo)', () => {
    expect(registry.LEE.map((e) => e.key)).toEqual(['aiInstructions', 'infoPdf', 'catalog', 'policies', 'faqs']);
    expect(registry.ENVIA.map((e) => e.resource)).toEqual(['logo', 'business_photos', 'presentation_video', 'brochure']);
    expect(registry.ENVIA.map((e) => e.mediaType)).toEqual(['image', 'image', 'video', 'document']);
  });

  test('claves únicas y cada entrada declara sección, origen y límites', () => {
    const todas = [...registry.LEE, ...registry.ENVIA, registry.ENVIA_DE_PRODUCTO];
    expect(new Set(todas.map((e) => e.key)).size).toBe(todas.length);
    todas.forEach((e) => {
      expect(e.section).toEqual(expect.any(String));
      expect(e.label).toEqual(expect.any(String));
      expect(e.origin.collection).toEqual(expect.any(String));
      expect(e.origin.fields.length).toBeGreaterThan(0);
      expect(e.limits).toBeTruthy();
    });
  });

  test('cada ENVIA tiene su consumidor send_media y el enum de la tool sale del registro (no hay lista paralela)', () => {
    const sendMedia = TOOL_REGISTRY.find((t) => t.name === 'send_media');
    expect(sendMedia.inputSchema.properties.resource.enum).toEqual(registry.RESOURCES_ENVIABLES);
    registry.ENVIA.forEach((e) => {
      expect(e.consumer).toMatchObject({ kind: 'tool', name: 'send_media', resource: e.resource });
      // La descripción de la tool menciona el recurso: la IA sabe que puede enviarlo.
      expect(`${sendMedia.description} ${sendMedia.inputSchema.properties.resource.description}`).toContain(e.resource);
    });
  });

  test('cada consumidor de tipo tool de LEE existe en TOOL_REGISTRY', () => {
    registry.LEE.flatMap((e) => e.consumers).filter((c) => c.kind === 'tool').forEach((c) => {
      expect(nombresDeTools).toContain(c.name);
    });
    expect(nombresDeTools).toContain(registry.ENVIA_DE_PRODUCTO.consumer.name);
  });

  test('cada consumidor de tipo prompt de LEE aparece de verdad en buildSystemPrompt', () => {
    const prompt = buildSystemPrompt(
      { name: 'Negocio', aiInstructions: 'Responde con calidez.', pdfSummary: 'Resumen del documento.' },
      { name: 'Lead' },
      null
    );
    registry.LEE.flatMap((e) => e.consumers).filter((c) => c.kind === 'prompt').forEach((c) => {
      expect(prompt).toContain(c.marker);
    });
  });

  test('cada entrada tiene un evaluador de «listo» en businessReadiness (si no, el estado por negocio quedaría ciego)', () => {
    registry.LEE.forEach((e) => expect(readiness.EVALUADORES_LEE[e.key]).toEqual(expect.any(Function)));
  });

  test('límites de WhatsApp coherentes con los tipos', () => {
    expect(registry.LIMITES_WHATSAPP).toEqual({ image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 100 * 1024 * 1024 });
    registry.ENVIA.forEach((e) => expect(e.limits.maxBytes).toBe(registry.LIMITES_WHATSAPP[e.mediaType]));
  });
});

// ── (a)(b)(d) CON MONGO REAL ─────────────────────────────────────────────────────────────────────────────────────────
const TENANTS = [
  { nombre: 'Negocio ficticio A', phone: '+51911111111' },
  { nombre: 'Negocio ficticio B', phone: '+56922222222' },
];

const ahora = () => new Date();
const asset = (businessId, resourceType, publicId, extra = {}) => ({
  provider: 'cloudinary', publicId, resourceType, deliveryType: 'authenticated', businessId, status: 'active',
  createdAt: ahora(), updatedAt: ahora(), ...extra,
});

describe.each(TENANTS)('contrato de comportamiento ($nombre)', ({ nombre, phone }) => {
  let business;
  let channel;
  let lead;
  let conversation;

  const contexto = async () => ({
    conversation: await Conversation.findById(conversation._id),
    business: await Business.findById(business._id),
    lead,
  });
  const llamar = async (name, args) => {
    const ctx = await contexto();
    return executeToolCall({ id: `call-${new mongoose.Types.ObjectId()}`, function: { name, arguments: JSON.stringify(args) } }, ctx);
  };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Promise.all([Policy.syncIndexes(), FAQ.syncIndexes(), Product.syncIndexes()]);
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  beforeEach(async () => {
    await Promise.all([
      Business, Lead, Product, Conversation, OutboundEvent, WhatsAppChannel, Policy, FAQ, BusinessDocumentChunk,
    ].map((m) => m.deleteMany({})));
    jest.clearAllMocks();
    business = await Business.create({ name: nombre });
    channel = await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000009', phoneNumberId: `pnid-contrato-${new mongoose.Types.ObjectId()}`, status: 'active',
    });
    lead = await Lead.create({ business: business._id, name: 'Lead', phone });
    conversation = await Conversation.create({
      business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, lastInboundMessageAt: ahora(),
    });
  });

  // ── (b) ENVIA → media válida hasta el payload de Gupshup ────────────────────────────────────────────────────────
  describe('(b) ENVIA: cada material sale como media del tipo correcto hasta el payload de Gupshup', () => {
    const cargarTodoElMaterial = () => Business.updateOne({ _id: business._id }, {
      $set: {
        logoAsset: asset(business._id, 'image', `negocios/${business._id}/logo`, { format: 'png', mimeType: 'image/png', size: 1000 }),
        photoAssets: [
          asset(business._id, 'image', `negocios/${business._id}/foto1`, { format: 'jpg', mimeType: 'image/jpeg', size: 1000 }),
          asset(business._id, 'image', `negocios/${business._id}/foto2`, { format: 'jpg', mimeType: 'image/jpeg', size: 1000 }),
        ],
        presentationVideoAsset: asset(business._id, 'video', `negocios/${business._id}/video`, { format: 'mp4', mimeType: 'video/mp4', size: 1000 }),
        brochureAsset: asset(business._id, 'raw', `negocios/${business._id}/brochure`, { format: 'pdf', mimeType: 'application/pdf', size: 1000 }),
        brochureFilename: 'Catalogo.pdf',
      },
    });

    const CASOS = [
      { resource: 'logo', args: {}, tipo: 'image' },
      { resource: 'business_photos', args: { photo: 1 }, tipo: 'image' },
      { resource: 'business_photos', args: { photo: 2 }, tipo: 'image' },
      { resource: 'presentation_video', args: {}, tipo: 'video' },
      { resource: 'brochure', args: {}, tipo: 'document', filename: 'Catalogo.pdf' },
    ];

    test.each(CASOS)('$resource $args → $tipo: la tool encola un OutboundEvent válido y el cliente Partner arma el body correcto', async ({ resource, args, tipo, filename }) => {
      await cargarTodoElMaterial();
      const r = await llamar('send_media', { resource, ...args });
      expect(r.success).toBe(true);
      expect(r.status).toBe('queued');

      const evento = await OutboundEvent.findById(r.outboundEventId);
      expect(evento).toMatchObject({ origin: 'ai', messageIntent: 'ai_automated', messageType: 'media' });
      const media = evento.payload.media;
      expect(media.type).toBe(tipo);
      expect(media.url).toMatch(/^https:\/\/api\.cloudinary\.com\/.+\/(image|video|raw)\/download\?/); // URL firmada, no pública
      expect(media.url).toContain('expires_at=');
      expect(media.filename).toBe(filename);

      // Hasta el payload de Gupshup (Partner v3): lo que el worker de salida le pasa al proveedor.
      const fetchSimulado = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messageId: 'wamid-x' }) });
      const original = global.fetch;
      global.fetch = fetchSimulado;
      try {
        await gupshupPartnerClient.sendMediaMessage('51911111111', media, { apiKey: 'k-prueba', appId: 'app-prueba' });
      } finally { global.fetch = original; }
      const body = JSON.parse(fetchSimulado.mock.calls[0][1].body);
      expect(body).toMatchObject({ messaging_product: 'whatsapp', type: tipo });
      expect(body[tipo].link).toBe(media.url);
      if (filename) expect(body.document.filename).toBe(filename);
    });

    test('las dos fotos del negocio son archivos distintos y se pueden enviar seguidas (anti-spam por foto, no por recurso)', async () => {
      await cargarTodoElMaterial();
      const ctx = await contexto();
      const uno = await executeToolCall({ id: 'a', function: { name: 'send_media', arguments: JSON.stringify({ resource: 'business_photos', photo: 1 }) } }, ctx);
      const dos = await executeToolCall({ id: 'b', function: { name: 'send_media', arguments: JSON.stringify({ resource: 'business_photos', photo: 2 }) } }, ctx);
      const repetida = await executeToolCall({ id: 'c', function: { name: 'send_media', arguments: JSON.stringify({ resource: 'business_photos', photo: 1 }) } }, ctx);
      expect([uno.success, dos.success, repetida.success]).toEqual([true, true, false]);
      const [e1, e2] = await Promise.all([OutboundEvent.findById(uno.outboundEventId), OutboundEvent.findById(dos.outboundEventId)]);
      expect(e1.payload.media.url).not.toBe(e2.payload.media.url);
    });

    test('un recurso sin nada cargado responde asset_missing (la IA lo dice), no un error técnico', async () => {
      const r = await llamar('send_media', { resource: 'brochure' });
      expect(r).toMatchObject({ success: false, status: 'asset_missing' });
      expect(await OutboundEvent.countDocuments({ tenantId: business._id })).toBe(0);
    });

    test('un material que solo existe como URL heredada (sin *Asset privado) NO se puede enviar y queda registrado como tal', async () => {
      await Business.updateOne({ _id: business._id }, { $set: { logo: 'https://res.cloudinary.com/cloud-de-prueba/image/upload/v1/viejo/logo.png' } });
      const r = await llamar('send_media', { resource: 'logo' });
      expect(r).toMatchObject({ success: false, status: 'asset_missing' });
      const estado = await readiness.evaluar(business._id);
      expect(estado.material.items.find((i) => i.key === 'logo')).toMatchObject({ loaded: true, connected: false, state: 'NOT_SENDABLE' });
      expect(estado.ready.material).toBe(false);
    });

    test('el PDF informativo NO es enviable por ninguna tool de envío', async () => {
      await Business.updateOne({ _id: business._id }, { $set: { pdfAsset: asset(business._id, 'raw', `negocios/${business._id}/info`, { format: 'pdf' }), pdfUrl: 'https://x.test/info.pdf' } });
      const r = await llamar('send_media', { resource: 'pdf' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Recurso desconocido/);
      expect(registry.RESOURCES_ENVIABLES).not.toContain('pdf');
    });

    test('fotos del catálogo: send_product_photos las envía como imagen (mismo contrato de media)', async () => {
      const producto = await Product.create({
        business: business._id, name: 'Producto de prueba', sku: 'SKU-CONTRATO-1', price: 10, stock: 5,
        mediaAssets: [{ ...asset(business._id, 'image', `negocios/${business._id}/productos/p1`, { format: 'jpg' }), isPrimary: true }],
      });
      const r = await llamar('send_product_photos', { productId: String(producto._id) });
      expect(r.success).toBe(true);
      expect((await OutboundEvent.findById(r.outboundEventId)).payload.media.type).toBe('image');
    });
  });

  // ── (a) LEE → consumidor real que devuelve contenido ────────────────────────────────────────────────────────────
  describe('(a) LEE: cada fuente llega al agente por su consumidor real', () => {
    const cargarConocimiento = async () => {
      await Business.updateOne({ _id: business._id }, {
        $set: {
          aiInstructions: 'Siempre saluda diciendo ¡Hola, bienvenido!',
          pdfUrl: 'https://x.test/info.pdf',
          pdfSummary: 'Somos una marca de nutrición natural con envíos a todo el país.',
          pdfExtractedText: 'Somos una marca de nutrición natural con envíos a todo el país. Vendemos granola artesanal y barras energéticas.',
        },
      });
      await BusinessDocumentChunk.create({
        business: business._id, documentId: new mongoose.Types.ObjectId(), documentVersion: 1, chunkIndex: 0, active: true,
        text: 'La granola artesanal se elabora con avena y miel de abeja.', page: 1, embedding: new Array(1536).fill(0.01),
      });
      await Product.create({ business: business._id, name: 'Proteína vegetal', sku: 'SKU-C-1', description: 'Proteína vegetal en polvo', price: 80, stock: 3, active: true });
      await Policy.create({
        business: business._id, code: 'RET-1', title: 'Cambios y devoluciones', category: 'returns', policyType: 'rule',
        statement: 'Se aceptan cambios hasta 7 días después de la compra.', status: 'active', scope: { appliesToAll: true },
      });
      await FAQ.create({
        business: business._id, question: '¿Aceptan Yape?', answer: 'Sí, aceptamos Yape.', category: 'payments', status: 'active', scope: { appliesToAll: true },
      });
    };

    test('aiInstructions y PDF (resumen) → buildSystemPrompt', async () => {
      await cargarConocimiento();
      const prompt = buildSystemPrompt(await Business.findById(business._id), lead, null);
      expect(prompt).toContain('Siempre saluda diciendo ¡Hola, bienvenido!');
      expect(prompt).toContain('Somos una marca de nutrición natural');
    });

    test('catálogo → search_products / get_price devuelven el producto y su precio real', async () => {
      await cargarConocimiento();
      const busqueda = await llamar('search_products', { query: 'proteína vegetal' });
      expect(busqueda.success).toBe(true);
      expect(busqueda.matches[0]).toMatchObject({ name: 'Proteína vegetal' });
      expect(busqueda.documentFallback).toBeUndefined(); // el producto existe: manda el catálogo
      const precio = await llamar('get_price', { productId: busqueda.matches[0].productId });
      expect(JSON.stringify(precio)).toContain('80');
    });

    test('políticas y FAQ → search_business_knowledge', async () => {
      await cargarConocimiento();
      const politicas = await llamar('search_business_knowledge', { query: 'cambios y devoluciones' });
      expect(politicas.success).toBe(true);
      expect(JSON.stringify(politicas.policies)).toContain('7 días');
      const faq = await llamar('search_business_knowledge', { query: 'aceptan Yape' });
      expect(JSON.stringify(faq.faqs)).toContain('Yape');
    });

    test('PDF → search_business_knowledge: sin índice vectorial (Mongo local) degrada al respaldo con el texto del PDF, sin error', async () => {
      await cargarConocimiento();
      const r = await llamar('search_business_knowledge', { query: 'granola artesanal miel' });
      expect(r.success).toBe(true);
      expect(r.documentStatus).toBe('indice_no_disponible');
      expect(JSON.stringify(r.documentFallback)).toContain('avena y miel de abeja');
    });

    test('PDF → search_products: un producto que NO está en el catálogo se responde con el PDF (respaldo directo)', async () => {
      await cargarConocimiento();
      const r = await llamar('search_products', { query: 'granola artesanal' });
      expect(r.success).toBe(true);
      expect(r.matches).toEqual([]);
      expect(r.catalogEmpty).toBeUndefined(); // hay catálogo: solo no tiene ese producto
      expect(JSON.stringify(r.documentFallback)).toContain('granola artesanal');
    });
  });

  // ── (d) 0 datos → degrada y dice qué falta; con datos → los usa ─────────────────────────────────────────────────
  describe('(d) degradación con 0 datos y estado «listo» por negocio', () => {
    test('negocio vacío: ninguna tool falla; devuelven vacío con las señales de qué falta', async () => {
      const productos = await llamar('search_products', { query: 'proteína' });
      expect(productos).toEqual({ success: true, matches: [], catalogEmpty: true });

      const conocimiento = await llamar('search_business_knowledge', { query: '¿cuál es la política de cambios?' });
      expect(conocimiento).toMatchObject({ success: true, policies: [], faqs: [], documentChunks: [] });
      // (en Mongo local el índice vectorial no existe ⇒ documentStatus 'indice_no_disponible'; con índice y sin PDF no se agrega nada)
      expect(conocimiento.documentFallback).toBeUndefined();
    });

    test('negocio vacío: el estado dice exactamente qué falta, por sección', async () => {
      const estado = await readiness.evaluar(business._id);
      expect(estado.ready).toEqual({ knowledge: false, material: false });
      expect(estado.knowledge.status).toBe('EMPTY');
      expect(estado.material.status).toBe('EMPTY');
      const todo = estado.missing.join(' | ');
      expect(todo).toMatch(/PDF informativo/);
      expect(todo).toMatch(/no cargaste productos/);
      expect(todo).toMatch(/políticas/);
      expect(todo).toMatch(/preguntas frecuentes/);
      expect(todo).toMatch(/logo/);
      expect(todo).toMatch(/brochure/);
      // Una entrada por cada sección del registro.
      const claves = [...estado.knowledge.items, ...estado.material.items].map((i) => i.key);
      expect(claves).toEqual([...registry.LEE, ...registry.ENVIA, registry.ENVIA_DE_PRODUCTO].map((e) => e.key));
    });

    test('con datos cargados y conectados el estado pasa a listo', async () => {
      await Business.updateOne({ _id: business._id }, {
        $set: {
          aiInstructions: 'Sé amable.',
          logoAsset: asset(business._id, 'image', `negocios/${business._id}/logo`, { format: 'png', mimeType: 'image/png', size: 1000 }),
        },
      });
      await Product.create({ business: business._id, name: 'Producto', sku: 'SKU-C-2', price: 5, stock: 1, active: true });
      const estado = await readiness.evaluar(business._id);
      expect(estado.ready).toEqual({ knowledge: true, material: true });
      expect(estado.knowledge.items.find((i) => i.key === 'catalog')).toMatchObject({ state: 'READY', count: 1 });
      expect(estado.material.items.find((i) => i.key === 'logo')).toMatchObject({ state: 'READY', connected: true });
    });

    test('PDF subido pero sin índice (no se pudo indexar) → DEGRADED: la IA usa el texto extraído y el estado lo avisa', async () => {
      await Business.updateOne({ _id: business._id }, { $set: { pdfUrl: 'https://x.test/info.pdf', pdfExtractedText: 'Texto del documento informativo del negocio.' } });
      const estado = await readiness.evaluar(business._id);
      const pdf = estado.knowledge.items.find((i) => i.key === 'infoPdf');
      expect(pdf).toMatchObject({ loaded: true, connected: true, state: 'DEGRADED' });
      expect(pdf.warnings.join(' ')).toMatch(/respaldo/);
    });

    test('PDF subido sin texto legible (escaneado) → FAILED, no conectado, y dice por qué', async () => {
      await Business.updateOne({ _id: business._id }, { $set: { pdfUrl: 'https://x.test/info.pdf' } });
      const estado = await readiness.evaluar(business._id);
      const pdf = estado.knowledge.items.find((i) => i.key === 'infoPdf');
      expect(pdf).toMatchObject({ loaded: true, connected: false, state: 'FAILED' });
      expect(pdf.missing.join(' ')).toMatch(/escaneado/);
      expect(estado.ready.knowledge).toBe(false);
    });

    test('el estado de un negocio no mezcla datos de otro (aislamiento por tenant)', async () => {
      const otro = await Business.create({ name: 'Otro negocio' });
      await Product.create({ business: otro._id, name: 'Producto ajeno', sku: 'SKU-AJENO', price: 5, stock: 1, active: true });
      const estado = await readiness.evaluar(business._id);
      expect(estado.knowledge.items.find((i) => i.key === 'catalog').count).toBe(0);
    });
  });
});
