// Test real (Jest, Mongo real) de product.service.js — CREA Product
// Intelligence™ V1.0, Etapa 2/10. Cubre el CRUD de gestión manual y las 3
// funciones de cara a la IA (buscarProductos/consultarStock/consultarPrecio),
// incluyendo el escenario de aislamiento multi-tenant que exige el
// documento maestro (§6, §34): mismo SKU en 2 negocios, precio/stock
// distintos, cada negocio debe ver solo el suyo.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const {
  crearProducto,
  obtenerProducto,
  listarProductos,
  actualizarProducto,
  desactivarProducto,
  buscarProductos,
  consultarStock,
  consultarPrecio,
} = require('./product.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_service';
const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('product.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('crearProducto / obtenerProducto', () => {
    test('crea un producto scoped al negocio', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'mor-001', name: 'Moringa 100 cápsulas' });

      expect(producto.business.toString()).toBe(business._id.toString());
      expect(producto.sku).toBe('MOR-001');
      expect(producto.source).toBe('manual');
    });

    test('rechaza un SKU duplicado en el mismo negocio con 409', async () => {
      await crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Moringa' });

      await expect(crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Otra moringa' }))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    test('permite el mismo SKU en 2 negocios distintos', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Moringa A' });

      const productoB = await crearProducto(otroBusiness._id, actor, { sku: 'MOR-001', name: 'Moringa B' });
      expect(productoB.sku).toBe('MOR-001');
    });

    test('obtenerProducto no encuentra un producto de OTRO negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const producto = await crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Moringa' });

      await expect(obtenerProducto(otroBusiness._id, producto._id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(obtenerProducto(business._id, producto._id)).resolves.toMatchObject({ sku: 'MOR-001' });
    });
  });

  describe('listarProductos', () => {
    test('pagina y filtra por categoría/activo', async () => {
      await crearProducto(business._id, actor, { sku: 'A', name: 'A', category: 'suplementos' });
      await crearProducto(business._id, actor, { sku: 'B', name: 'B', category: 'suplementos' });
      await crearProducto(business._id, actor, { sku: 'C', name: 'C', category: 'aceites' });

      const { productos, total } = await listarProductos(business._id, { category: 'suplementos' });
      expect(total).toBe(2);
      expect(productos.map((p) => p.sku).sort()).toEqual(['A', 'B']);
    });

    test('no trae productos de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await crearProducto(business._id, actor, { sku: 'A', name: 'A' });
      await crearProducto(otroBusiness._id, actor, { sku: 'B', name: 'B' });

      const { productos, total } = await listarProductos(business._id, {});
      expect(total).toBe(1);
      expect(productos[0].sku).toBe('A');
    });
  });

  describe('actualizarProducto / desactivarProducto', () => {
    test('actualiza campos y valida SKU duplicado al cambiarlo', async () => {
      await crearProducto(business._id, actor, { sku: 'A', name: 'Producto A' });
      const b = await crearProducto(business._id, actor, { sku: 'B', name: 'Producto B' });

      const actualizado = await actualizarProducto(business._id, b._id, actor, { price: 50 });
      expect(actualizado.price).toBe(50);

      await expect(actualizarProducto(business._id, b._id, actor, { sku: 'A' })).rejects.toMatchObject({ statusCode: 409 });
    });

    test('desactivarProducto pone active:false, NUNCA borra el documento', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'Producto A' });
      await desactivarProducto(business._id, producto._id);

      const enDb = await Product.findById(producto._id);
      expect(enDb).not.toBeNull();
      expect(enDb.active).toBe(false);
    });

    test('reactivar (active:true vía actualizarProducto) NO libera el SKU para crear otro producto con el mismo código', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'Producto A' });
      await desactivarProducto(business._id, producto._id);

      // Confirmado con el usuario: un SKU desactivado sigue bloqueado — un
      // "lote nuevo" del mismo código debe ser un registro nuevo con OTRO SKU,
      // nunca reutilizar este.
      await expect(crearProducto(business._id, actor, { sku: 'A', name: 'Producto A, lote nuevo' }))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('buscarProductos() — search_products()', () => {
    beforeEach(async () => {
      await crearProducto(business._id, actor, {
        sku: 'TQ-MOR-100',
        name: 'Harina de Moringa Te Quiero',
        description: 'Cápsulas de moringa en polvo',
        keywords: ['moringa', 'capsulas', 'pastillas'],
        price: 50,
        physicalStock: 43,
      });
      await crearProducto(business._id, actor, {
        sku: 'ACE-001',
        name: 'Aceite de coco',
        keywords: ['aceite', 'coco'],
        price: 30,
      });
    });

    test('encuentra por keyword aunque no esté en el nombre ("pastillas" → producto con esa keyword)', async () => {
      const resultados = await buscarProductos(business._id, 'pastillas de moringa');
      expect(resultados).toHaveLength(1);
      expect(resultados[0].sku).toBe('TQ-MOR-100');
    });

    test('tolera plural/singular (stemming en español) — "capsulas" encuentra keyword "capsulas" igual buscando en singular', async () => {
      const resultados = await buscarProductos(business._id, 'capsula');
      expect(resultados.map((r) => r.sku)).toContain('TQ-MOR-100');
    });

    test('el mejor match queda con matchScore 1.0', async () => {
      const resultados = await buscarProductos(business._id, 'moringa');
      expect(resultados[0].matchScore).toBe(1);
    });

    test('no devuelve productos desactivados', async () => {
      const producto = await Product.findOne({ business: business._id, sku: 'TQ-MOR-100' });
      producto.active = false;
      await producto.save();

      const resultados = await buscarProductos(business._id, 'moringa');
      expect(resultados).toHaveLength(0);
    });

    test('resuelve currency al fallback del negocio cuando el producto no tiene una propia', async () => {
      const resultados = await buscarProductos(business._id, 'aceite');
      expect(resultados[0].currency).toBe(business.currency); // 'MXN' por default
    });

    test('sin resultados devuelve array vacío, no lanza', async () => {
      const resultados = await buscarProductos(business._id, 'algo que no existe en el catálogo');
      expect(resultados).toEqual([]);
    });
  });

  describe('consultarStock() — check_stock()', () => {
    test('trackInventory:true — inStock/lowStock calculados sobre availableStock', async () => {
      const producto = await crearProducto(business._id, actor, {
        sku: 'A', name: 'A', physicalStock: 5, reservedStock: 0, minimumStock: 10,
      });

      const stock = await consultarStock(business._id, producto._id);
      expect(stock).toMatchObject({ trackInventory: true, physicalStock: 5, availableStock: 5, inStock: true, lowStock: true });
    });

    test('stock 0 → inStock:false ("agotado")', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'A', physicalStock: 0 });
      const stock = await consultarStock(business._id, producto._id);
      expect(stock.inStock).toBe(false);
    });

    test('trackInventory:false (servicio) — nunca reporta "agotado", devuelve NOT_TRACKED', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'SRV', name: 'Consultoría', trackInventory: false });
      const stock = await consultarStock(business._id, producto._id);
      expect(stock).toEqual({ productId: producto._id, trackInventory: false, availability: 'NOT_TRACKED' });
    });

    test('un producto desactivado no es encontrable (404), aunque el id sea válido', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'A' });
      await desactivarProducto(business._id, producto._id);

      await expect(consultarStock(business._id, producto._id)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('aislamiento por tenant: un negocio no puede consultar stock de un producto de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'A' });

      await expect(consultarStock(otroBusiness._id, producto._id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('consultarPrecio() — get_price()', () => {
    test('priceAvailable:true con el precio y moneda del producto', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'A', price: 50, currency: 'PEN' });
      const precio = await consultarPrecio(business._id, producto._id);
      expect(precio).toEqual({ productId: producto._id, price: 50, currency: 'PEN', priceAvailable: true });
    });

    test('sin precio cargado → priceAvailable:false, sin inventar un número', async () => {
      const producto = await crearProducto(business._id, actor, { sku: 'A', name: 'A' });
      const precio = await consultarPrecio(business._id, producto._id);
      expect(precio).toEqual({ productId: producto._id, priceAvailable: false });
    });
  });

  describe('aislamiento multi-tenant (documento maestro §34): mismo SKU, precio y stock distintos', () => {
    test('cada negocio ve su propio precio/stock para el mismo SKU, nunca el del otro', async () => {
      const businessB = await Business.create({ name: 'Negocio B' });

      const productoA = await crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Moringa', price: 50, currency: 'PEN', physicalStock: 10 });
      const productoB = await crearProducto(businessB._id, actor, { sku: 'MOR-001', name: 'Moringa', price: 65, currency: 'PEN', physicalStock: 100 });

      await expect(consultarPrecio(business._id, productoA._id)).resolves.toMatchObject({ price: 50 });
      await expect(consultarPrecio(businessB._id, productoB._id)).resolves.toMatchObject({ price: 65 });

      // Cruzado: el id de A consultado con el tenant de B (o viceversa) no debe resolver NUNCA.
      await expect(consultarPrecio(businessB._id, productoA._id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(consultarPrecio(business._id, productoB._id)).rejects.toMatchObject({ statusCode: 404 });

      await expect(consultarStock(business._id, productoA._id)).resolves.toMatchObject({ physicalStock: 10 });
      await expect(consultarStock(businessB._id, productoB._id)).resolves.toMatchObject({ physicalStock: 100 });
    });

    test('la importación/creación en un negocio nunca es visible en la búsqueda del otro', async () => {
      const businessB = await Business.create({ name: 'Negocio B' });
      await crearProducto(business._id, actor, { sku: 'MOR-001', name: 'Moringa exclusiva de A' });

      const resultadosEnB = await buscarProductos(businessB._id, 'moringa');
      expect(resultadosEnB).toEqual([]);
    });
  });
});
