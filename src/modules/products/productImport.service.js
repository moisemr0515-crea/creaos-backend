const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const Product = require('./product.model');
const logger = require('../../utils/logger');
const { AppError } = require('../../middleware/error.middleware');

// CREA Product Intelligence™ V1.0 — Etapa 5/10 (importador Excel/CSV,
// documento maestro §10-12/§26). Reusa xlsx/csv-parse tal cual (mismas
// librerías que ya usa imports/import.service.js para Leads) — pero NO
// reusa ese archivo ni su flujo: acá el preview NUNCA persiste nada
// (import.service.js de Leads es upload→persiste en un solo paso), y la
// confirmación vuelve a recibir el archivo completo (no un JSON eco de las
// filas ya validadas) — se reparsea y revalida desde los bytes reales cada
// vez, nunca confiando en un preview editable del lado del cliente para la
// escritura real.

// Documento §26 ("seguridad de archivos: límite de filas") — independiente
// del límite de 5MB de multer (ver product.routes.js): un archivo chico
// pero con decenas de miles de filas casi vacías igual sería costoso de
// procesar/validar fila por fila, y no tiene sentido real un catálogo
// manual de más de 5000 productos en una sola importación.
const MAX_FILAS = 5000;

// Documento §10.1 — columnas del template recomendado, en español. Las
// keys de este mapa son encabezados YA normalizados (ver
// normalizarEncabezado(): minúsculas, sin acentos, sin espacios/guiones) —
// así "Categoría", "categoria", "CATEGORIA" y "categoria " matchean todos
// a la misma columna, tolerando que alguien edite el template a mano.
const COLUMNAS_CONOCIDAS = {
  sku: 'sku',
  nombre: 'name',
  descripcion: 'description',
  categoria: 'category',
  marca: 'brand',
  precio: 'price',
  moneda: 'currency',
  stock: 'physicalStock',
  stockminimo: 'minimumStock',
  controlarinventario: 'trackInventory',
  keywords: 'keywords',
  palabrasclave: 'keywords',
  sinonimos: 'synonyms',
  activo: 'active',
};

const normalizarEncabezado = (str) =>
  String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca acentos (categoria con tilde -> categoria, via NFD)
    .replace(/[\s_-]+/g, ''); // saca espacios/guiones/guion bajo (stock_minimo → stockminimo)

const parsearCSV = (buffer) => {
  try {
    return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw new AppError(`Error al parsear CSV: ${err.message}`, 400);
  }
};

const parsearXLSX = (buffer) => {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    throw new AppError(`Error al parsear XLSX: ${err.message}`, 400);
  }
};

/**
 * Parsea el archivo a filas crudas (array de objetos, claves = encabezados
 * tal cual vinieron). Nunca ejecuta macros ni fórmulas como código — `xlsx`
 * (SheetJS) solo lee valores de celda, no tiene capacidad de ejecución
 * (documento §26). Lanza AppError (400) ante formato no soportado, archivo
 * vacío, o más filas que MAX_FILAS — los 3 únicos casos donde no tiene
 * sentido devolver un preview parcial.
 */
const parsearArchivo = (file) => {
  const ext = file.originalname.split('.').pop().toLowerCase();

  let rows;
  if (ext === 'csv') {
    rows = parsearCSV(file.buffer);
  } else if (['xlsx', 'xls'].includes(ext)) {
    rows = parsearXLSX(file.buffer);
  } else {
    throw new AppError('Formato no soportado. Usa CSV, XLSX o XLS', 400);
  }

  if (!rows.length) throw new AppError('El archivo no contiene filas de datos', 400);
  if (rows.length > MAX_FILAS) {
    throw new AppError(
      `El archivo tiene ${rows.length} filas — el máximo permitido por importación es ${MAX_FILAS}. Dividilo en archivos más chicos.`,
      400
    );
  }

  return rows;
};

const VALORES_VERDADEROS = ['si', 'sí', 'true', '1', 'verdadero', 'yes'];
const VALORES_FALSOS = ['no', 'false', '0', 'falso'];

/** Un valor no reconocido (ni verdadero ni falso) cae al default — no se
 * marca como error, para no ser puntilloso con una celda mal tipeada que
 * de todos modos tiene un default razonable (activo/con inventario). */
const parseBooleano = (valor, porDefecto) => {
  const v = String(valor).trim().toLowerCase();
  if (VALORES_VERDADEROS.includes(v)) return true;
  if (VALORES_FALSOS.includes(v)) return false;
  return porDefecto;
};

const splitList = (valor) =>
  String(valor)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Traduce una fila cruda a sus campos conocidos (valores todavía sin
 * castear) usando COLUMNAS_CONOCIDAS + normalizarEncabezado(). Encabezados
 * que no matchean ninguna columna se acumulan en `columnasDesconocidas`
 * (documento §11 — "columnas desconocidas") para reportarlas aparte, sin
 * bloquear el resto del archivo por una columna extra.
 */
const mapearFila = (rawRow, columnasDesconocidas) => {
  const mapped = {};
  for (const [header, valorCrudo] of Object.entries(rawRow)) {
    const campo = COLUMNAS_CONOCIDAS[normalizarEncabezado(header)];
    if (!campo) {
      if (String(header).trim()) columnasDesconocidas.add(String(header).trim());
      continue;
    }
    mapped[campo] = valorCrudo;
  }
  return mapped;
};

/**
 * Convierte los valores crudos de una fila ya mapeada a un objeto SPARSE
 * (solo las claves con un valor real, no vacío) con el tipo/casteo final —
 * a propósito, NO rellena con defaults acá. Una celda vacía significa
 * "no provisto", no "poné el default" — necesario para que reimportar el
 * mismo archivo (ej. para actualizar solo el precio) nunca borre en
 * silencio otros campos (keywords, categoría, etc.) de un producto
 * EXISTENTE que el archivo no volvió a completar. Para un producto NUEVO,
 * los campos ausentes los completa el propio esquema de Mongoose
 * (`setDefaultsOnInsert:true` en el upsert, ver confirmarImportacion()) —
 * no hace falta duplicar esos defaults acá.
 */
const camposDesdeFila = (datosCrudos) => {
  const campos = {};
  const tieneValor = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  if (tieneValor(datosCrudos.sku)) campos.sku = String(datosCrudos.sku).trim().toUpperCase();
  if (tieneValor(datosCrudos.name)) campos.name = String(datosCrudos.name).trim();
  if (tieneValor(datosCrudos.description)) campos.description = String(datosCrudos.description).trim();
  if (tieneValor(datosCrudos.category)) campos.category = String(datosCrudos.category).trim();
  if (tieneValor(datosCrudos.brand)) campos.brand = String(datosCrudos.brand).trim();
  if (tieneValor(datosCrudos.price)) campos.price = Number(datosCrudos.price);
  if (tieneValor(datosCrudos.currency)) campos.currency = String(datosCrudos.currency).trim().toUpperCase();
  if (tieneValor(datosCrudos.trackInventory)) campos.trackInventory = parseBooleano(datosCrudos.trackInventory, true);
  if (tieneValor(datosCrudos.physicalStock)) campos.physicalStock = Number(datosCrudos.physicalStock);
  if (tieneValor(datosCrudos.minimumStock)) campos.minimumStock = Number(datosCrudos.minimumStock);
  if (tieneValor(datosCrudos.keywords)) campos.keywords = splitList(datosCrudos.keywords);
  if (tieneValor(datosCrudos.synonyms)) campos.synonyms = splitList(datosCrudos.synonyms);
  if (tieneValor(datosCrudos.active)) campos.active = parseBooleano(datosCrudos.active, true);

  return campos;
};

/**
 * Valida una fila ya convertida a `campos` (sparse) — documento §11. Nunca
 * lanza; devuelve {errores:[]} para que el caller decida si la fila entra
 * al lote a escribir o no. `sku`/`name` son obligatorios en TODA fila (el
 * documento no distingue alta de actualización acá) — a diferencia del
 * resto de los campos, que si vienen vacíos simplemente no se tocan (ver
 * camposDesdeFila()).
 */
const validarFila = (campos) => {
  const errores = [];

  if (!campos.sku) errores.push('SKU vacío');
  if (!campos.name) errores.push('Nombre vacío');

  if (campos.price !== undefined && (!Number.isFinite(campos.price) || campos.price < 0)) {
    errores.push(`Precio inválido: "${campos.price}"`);
  }
  if (campos.physicalStock !== undefined && (!Number.isFinite(campos.physicalStock) || campos.physicalStock < 0)) {
    errores.push(`Stock inválido: "${campos.physicalStock}"`);
  }
  if (campos.minimumStock !== undefined && (!Number.isFinite(campos.minimumStock) || campos.minimumStock < 0)) {
    errores.push(`Stock mínimo inválido: "${campos.minimumStock}"`);
  }
  if (campos.currency !== undefined && campos.currency.length !== 3) {
    errores.push(`Moneda inválida: "${campos.currency}" (debe ser un código ISO 4217 de 3 letras)`);
  }

  return errores;
};

/**
 * Parsea + valida el archivo completo — el corazón compartido de preview y
 * confirm (documento §10.2: mismo criterio de validación en los 2 pasos,
 * nunca una versión "relajada" para preview y otra "estricta" para
 * confirmar). NO escribe nada en la base — ni siquiera en el paso de
 * confirmación, que llama a esto primero y recién después escribe.
 */
const parsearYValidarArchivo = async (businessId, file) => {
  const rowsCrudas = parsearArchivo(file);
  const columnasDesconocidas = new Set();

  // Un solo find() para saber qué SKUs de ESTE negocio ya existen — evita
  // una query por fila. Un SKU de OTRO negocio es simplemente invisible acá
  // (el filtro siempre incluye business:businessId) — así es como el
  // documento §12 ("SKU existente en otro tenant se ignora") queda
  // resuelto sin ningún chequeo especial: nunca se le puede pisar el
  // producto a otro negocio porque nunca aparece en `skusExistentes`.
  const existentes = await Product.find({ business: businessId }).select('sku').lean();
  const skusExistentes = new Set(existentes.map((p) => p.sku));

  const skusVistosEnArchivo = new Set();
  const filas = [];

  rowsCrudas.forEach((rawRow, i) => {
    const numeroFila = i + 2; // +1 por el encabezado, +1 porque las hojas de cálculo empiezan en 1
    const datosCrudos = mapearFila(rawRow, columnasDesconocidas);
    const campos = camposDesdeFila(datosCrudos);
    const errores = validarFila(campos);

    // "Filas duplicadas" y "SKU duplicado dentro del archivo" (documento
    // §11) son la MISMA regla acá: el SKU es la clave de upsert, así que
    // 2 filas con el mismo SKU son ambiguas para el upsert sin importar si
    // el resto de sus columnas coincide o no. La primera aparición queda
    // válida; la 2ª en adelante se marca con error.
    if (campos.sku) {
      if (skusVistosEnArchivo.has(campos.sku)) {
        errores.push('SKU duplicado dentro del archivo (ya aparece en una fila anterior)');
      } else {
        skusVistosEnArchivo.add(campos.sku);
      }
    }

    const accion = campos.sku && skusExistentes.has(campos.sku) ? 'actualizar' : 'crear';

    filas.push({ numeroFila, sku: campos.sku || null, campos, accion, errores, advertencias: [] });
  });

  // Columnas desconocidas (documento §11): no bloquean el archivo, se
  // ignoran — pero se avisan tanto a nivel de archivo (advertenciasGenerales,
  // para mostrar arriba de la tabla) como en cada fila (para que el conteo
  // "Con advertencias" del resumen las refleje, ya que técnicamente afectan
  // a todas las filas por igual).
  const advertenciasGenerales = [...columnasDesconocidas].map((col) => `Columna desconocida "${col}" — se ignoró`);
  if (advertenciasGenerales.length) {
    filas.forEach((f) => f.advertencias.push(...advertenciasGenerales));
  }

  const resumen = {
    totalFilas: filas.length,
    // "Válidas" = sin errores (se van a escribir), independientemente de si
    // además tienen alguna advertencia — una advertencia nunca excluye una
    // fila de la importación, a diferencia de un error.
    validas: filas.filter((f) => f.errores.length === 0).length,
    conAdvertencias: filas.filter((f) => f.errores.length === 0 && f.advertencias.length > 0).length,
    conErrores: filas.filter((f) => f.errores.length > 0).length,
  };

  return { filas, resumen, advertenciasGenerales };
};

const previsualizarImportacion = async (businessId, file) => {
  const resultado = await parsearYValidarArchivo(businessId, file);
  logger.info(
    `PRODUCT_IMPORT_PREVIEW: business=${businessId} archivo=${file.originalname} filas=${resultado.resumen.totalFilas} validas=${resultado.resumen.validas} conErrores=${resultado.resumen.conErrores}`
  );
  return resultado;
};

/**
 * Vuelve a parsear y validar el archivo desde cero (nunca confía en un
 * preview previo que el cliente pudiera reenviar editado) y recién
 * entonces escribe — upsert por {business, sku} (documento §12): SKU nuevo
 * en este negocio → crea; SKU existente en este negocio → actualiza SOLO
 * los campos que la fila trajo con valor (ver camposDesdeFila()); nunca
 * borra productos ausentes del archivo. Cada fila se escribe en su propio
 * try/catch — un fallo puntual (ej. una condición de carrera rarísima con
 * el índice único) no aborta el resto del lote, mismo criterio fail-soft
 * que import.service.js (Leads) con insertMany({ordered:false}).
 */
const confirmarImportacion = async (businessId, actor, file) => {
  logger.info(`PRODUCT_IMPORT_STARTED: business=${businessId} archivo=${file.originalname} actor=${actor?._id}`);

  const { filas, resumen } = await parsearYValidarArchivo(businessId, file);
  const filasValidas = filas.filter((f) => f.errores.length === 0);

  let creados = 0;
  let actualizados = 0;
  const erroresEscritura = [];

  for (const fila of filasValidas) {
    try {
      // eslint-disable-next-line no-await-in-loop -- cada fila es una escritura
      // independiente; no hay nada que paralelizar de forma segura acá (el
      // índice único {business,sku} ya protege contra colisiones entre sí).
      await Product.findOneAndUpdate(
        { business: businessId, sku: fila.sku },
        {
          $set: { ...fila.campos, source: 'import' },
          $setOnInsert: { business: businessId },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: true, context: 'query' }
      );
      if (fila.accion === 'crear') creados += 1;
      else actualizados += 1;
    } catch (err) {
      erroresEscritura.push({ numeroFila: fila.numeroFila, sku: fila.sku, error: err.message });
    }
  }

  const resultado = {
    resumen: {
      totalFilas: resumen.totalFilas,
      nuevos: creados,
      actualizados,
      erroresValidacion: resumen.conErrores,
      erroresEscritura: erroresEscritura.length,
    },
    erroresValidacion: filas
      .filter((f) => f.errores.length > 0)
      .map((f) => ({ numeroFila: f.numeroFila, sku: f.sku, errores: f.errores })),
    erroresEscritura,
  };

  logger.info(
    `PRODUCT_IMPORT_COMPLETED: business=${businessId} archivo=${file.originalname} nuevos=${creados} actualizados=${actualizados} erroresValidacion=${resumen.conErrores} erroresEscritura=${erroresEscritura.length}`
  );

  return resultado;
};

module.exports = {
  MAX_FILAS,
  previsualizarImportacion,
  confirmarImportacion,
};
