const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const Policy = require('./policy.model');
const { POLICY_CATEGORIES, POLICY_TYPES, POLICY_STATUSES } = Policy;
const logger = require('../../utils/logger');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 9/11
// (importación con preview, documento §18). Mismo criterio EXACTO que
// productImport.service.js (Product Intelligence, Etapa 5/10) — reusa
// xlsx/csv-parse tal cual, preview nunca persiste nada, confirm re-parsea
// y revalida desde los bytes reales (nunca confía en un preview editable
// del cliente).
//
// Diferencia clave con Product: acá el upsert es por {business, code}
// (documento §18: "code,title,category,statement,priority,status,
// effective_from,effective_until,tags") — mismo rol que {business, sku}
// en Product. `policyType` no está en la lista de columnas sugerida por
// el documento, pero es un campo REQUERIDO del schema (policy.model.js) —
// se agrega como columna obligatoria acá en vez de asumir un default
// silencioso (ej. "rule"): qué tipo de política es no es una decisión que
// este importador deba tomar por el negocio.
//
// `scope`/`action` (sub-objetos con referencias a Product/WhatsAppChannel)
// quedan FUERA de este importador a propósito — el documento §18 mismo
// dice "el objetivo inmediato es entrada manual y una importación
// sencilla"; toda Policy importada queda con scope:{appliesToAll:true} y
// action:{responseMode:'answer'} (defaults del schema) — si el negocio
// necesita acotar a un producto/canal puntual o handoff, lo edita después
// vía CRUD manual (Etapa 5, ya existente).
const MAX_FILAS = 5000;

const COLUMNAS_CONOCIDAS = {
  code: 'code',
  codigo: 'code',
  title: 'title',
  titulo: 'title',
  description: 'description',
  descripcion: 'description',
  category: 'category',
  categoria: 'category',
  policytype: 'policyType',
  tipo: 'policyType',
  tipodepolitica: 'policyType',
  statement: 'statement',
  texto: 'statement',
  customerfacingtext: 'customerFacingText',
  textoparaelcliente: 'customerFacingText',
  priority: 'priority',
  prioridad: 'priority',
  status: 'status',
  estado: 'status',
  effectivefrom: 'effectiveFrom',
  vigenciadesde: 'effectiveFrom',
  effectiveuntil: 'effectiveUntil',
  vigenciahasta: 'effectiveUntil',
  tags: 'tags',
  etiquetas: 'tags',
};

// Rango Unicode de marcas diacríticas combinantes (U+0300–U+036F, en
// decimal 768–879), filtrado vía codePointAt() en vez de un literal de
// regex — mismo motivo y mismo workaround ya documentado en
// faq.model.js#quitarDiacriticos(): escribir el escape `\uXXXX` como
// texto ASCII en este archivo se corrompe de forma reproducible al
// guardarlo (confirmado con una prueba dedicada antes de este commit).
const RANGO_DIACRITICOS_MIN = 768;
const RANGO_DIACRITICOS_MAX = 879;

const quitarDiacriticos = (str) =>
  str
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code < RANGO_DIACRITICOS_MIN || code > RANGO_DIACRITICOS_MAX;
    })
    .join('');

const normalizarEncabezado = (str) =>
  quitarDiacriticos(
    String(str || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
  ).replace(/[\s_-]+/g, '');

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

const splitList = (valor) =>
  String(valor)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
 * Mismo criterio que camposDesdeFila() de productImport.service.js: objeto
 * SPARSE (solo claves con valor real) — una celda vacía en una fila de
 * ACTUALIZACIÓN (code ya existente) nunca borra en silencio un campo que
 * el archivo no volvió a completar. `status` default 'draft' en el schema
 * cubre el caso de alta sin revisión humana (documento §18 último párrafo,
 * mismo espíritu aplicado acá aunque hable de PDFs) — nunca se fuerza acá
 * un default distinto al del schema.
 */
const camposDesdeFila = (datosCrudos) => {
  const campos = {};
  const tieneValor = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  if (tieneValor(datosCrudos.code)) campos.code = String(datosCrudos.code).trim().toUpperCase();
  if (tieneValor(datosCrudos.title)) campos.title = String(datosCrudos.title).trim();
  if (tieneValor(datosCrudos.description)) campos.description = String(datosCrudos.description).trim();
  if (tieneValor(datosCrudos.category)) campos.category = String(datosCrudos.category).trim().toLowerCase();
  if (tieneValor(datosCrudos.policyType)) campos.policyType = String(datosCrudos.policyType).trim().toLowerCase();
  if (tieneValor(datosCrudos.statement)) campos.statement = String(datosCrudos.statement).trim();
  if (tieneValor(datosCrudos.customerFacingText)) campos.customerFacingText = String(datosCrudos.customerFacingText).trim();
  if (tieneValor(datosCrudos.priority)) campos.priority = Number(datosCrudos.priority);
  if (tieneValor(datosCrudos.status)) campos.status = String(datosCrudos.status).trim().toLowerCase();
  if (tieneValor(datosCrudos.effectiveFrom)) campos.effectiveFrom = new Date(datosCrudos.effectiveFrom);
  if (tieneValor(datosCrudos.effectiveUntil)) campos.effectiveUntil = new Date(datosCrudos.effectiveUntil);
  if (tieneValor(datosCrudos.tags)) campos.tags = splitList(datosCrudos.tags).map((t) => t.toLowerCase());

  return campos;
};

const validarFila = (campos) => {
  const errores = [];

  if (!campos.code) errores.push('code vacío');
  if (!campos.title) errores.push('title vacío');
  if (!campos.category) errores.push('category vacío');
  else if (!POLICY_CATEGORIES.includes(campos.category)) {
    errores.push(`category inválida: "${campos.category}" (valores válidos: ${POLICY_CATEGORIES.join(', ')})`);
  }
  if (!campos.policyType) errores.push('policyType vacío');
  else if (!POLICY_TYPES.includes(campos.policyType)) {
    errores.push(`policyType inválido: "${campos.policyType}" (valores válidos: ${POLICY_TYPES.join(', ')})`);
  }
  if (!campos.statement) errores.push('statement vacío');

  if (campos.priority !== undefined && (!Number.isInteger(campos.priority) || campos.priority < 0 || campos.priority > 100)) {
    errores.push(`priority inválida: "${campos.priority}" (debe ser un entero entre 0 y 100)`);
  }
  if (campos.status !== undefined && !POLICY_STATUSES.includes(campos.status)) {
    errores.push(`status inválido: "${campos.status}" (valores válidos: ${POLICY_STATUSES.join(', ')})`);
  }
  if (campos.effectiveFrom !== undefined && Number.isNaN(campos.effectiveFrom.getTime())) {
    errores.push('effectiveFrom inválida (fecha no reconocida)');
  }
  if (campos.effectiveUntil !== undefined && Number.isNaN(campos.effectiveUntil.getTime())) {
    errores.push('effectiveUntil inválida (fecha no reconocida)');
  }
  if (
    campos.effectiveFrom !== undefined &&
    campos.effectiveUntil !== undefined &&
    !Number.isNaN(campos.effectiveFrom.getTime()) &&
    !Number.isNaN(campos.effectiveUntil.getTime()) &&
    campos.effectiveUntil <= campos.effectiveFrom
  ) {
    errores.push('effectiveUntil debe ser posterior a effectiveFrom');
  }

  return errores;
};

/**
 * Parsea + valida el archivo completo — mismo corazón compartido de
 * preview/confirm que productImport.service.js#parsearYValidarArchivo().
 * Upsert por {business, code} (documento §18, mismo rol que {business,
 * sku} en Product): code nuevo en este negocio → crea; code existente →
 * actualiza. Un `code` de otro negocio es invisible acá (el filtro
 * siempre incluye business:businessId), igual que con sku en Product.
 */
const parsearYValidarArchivo = async (businessId, file) => {
  const rowsCrudas = parsearArchivo(file);
  const columnasDesconocidas = new Set();

  const existentes = await Policy.find({ business: businessId }).select('code').lean();
  const codesExistentes = new Set(existentes.map((p) => p.code));

  const codesVistosEnArchivo = new Set();
  const filas = [];

  rowsCrudas.forEach((rawRow, i) => {
    const numeroFila = i + 2;
    const datosCrudos = mapearFila(rawRow, columnasDesconocidas);
    const campos = camposDesdeFila(datosCrudos);
    const errores = validarFila(campos);

    if (campos.code) {
      if (codesVistosEnArchivo.has(campos.code)) {
        errores.push('code duplicado dentro del archivo (ya aparece en una fila anterior)');
      } else {
        codesVistosEnArchivo.add(campos.code);
      }
    }

    const accion = campos.code && codesExistentes.has(campos.code) ? 'actualizar' : 'crear';

    filas.push({ numeroFila, code: campos.code || null, campos, accion, errores, advertencias: [] });
  });

  const advertenciasGenerales = [...columnasDesconocidas].map((col) => `Columna desconocida "${col}" — se ignoró`);
  if (advertenciasGenerales.length) {
    filas.forEach((f) => f.advertencias.push(...advertenciasGenerales));
  }

  const resumen = {
    totalFilas: filas.length,
    validas: filas.filter((f) => f.errores.length === 0).length,
    conAdvertencias: filas.filter((f) => f.errores.length === 0 && f.advertencias.length > 0).length,
    conErrores: filas.filter((f) => f.errores.length > 0).length,
  };

  return { filas, resumen, advertenciasGenerales };
};

const previsualizarImportacion = async (businessId, file) => {
  const resultado = await parsearYValidarArchivo(businessId, file);
  logger.info(
    `POLICY_IMPORT_PREVIEW: business=${businessId} archivo=${file.originalname} filas=${resultado.resumen.totalFilas} validas=${resultado.resumen.validas} conErrores=${resultado.resumen.conErrores}`
  );
  return resultado;
};

const confirmarImportacion = async (businessId, actor, file) => {
  logger.info(`POLICY_IMPORT_STARTED: business=${businessId} archivo=${file.originalname} actor=${actor?._id}`);

  const { filas, resumen } = await parsearYValidarArchivo(businessId, file);
  const filasValidas = filas.filter((f) => f.errores.length === 0);

  let creados = 0;
  let actualizados = 0;
  const erroresEscritura = [];

  for (const fila of filasValidas) {
    try {
      // eslint-disable-next-line no-await-in-loop -- cada fila es una escritura
      // independiente, mismo criterio que confirmarImportacion() de Product.
      await Policy.findOneAndUpdate(
        { business: businessId, code: fila.code },
        {
          $set: { ...fila.campos, source: { type: 'import', reference: file.originalname } },
          $setOnInsert: { business: businessId, createdBy: actor?._id ?? null },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: true, context: 'query' }
      );
      if (fila.accion === 'crear') creados += 1;
      else actualizados += 1;
    } catch (err) {
      erroresEscritura.push({ numeroFila: fila.numeroFila, code: fila.code, error: err.message });
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
      .map((f) => ({ numeroFila: f.numeroFila, code: f.code, errores: f.errores })),
    erroresEscritura,
  };

  logger.info(
    `POLICY_IMPORT_COMPLETED: business=${businessId} archivo=${file.originalname} nuevos=${creados} actualizados=${actualizados} erroresValidacion=${resumen.conErrores} erroresEscritura=${erroresEscritura.length}`
  );

  return resultado;
};

module.exports = {
  MAX_FILAS,
  previsualizarImportacion,
  confirmarImportacion,
};
