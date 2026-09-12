const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const FAQ = require('./faq.model');
const { FAQ_CATEGORIES, FAQ_STATUSES } = FAQ;
const logger = require('../../utils/logger');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 9/11. Ver
// policyImport.service.js para el criterio compartido (no se repite acá).
//
// Diferencia clave con Policy (y con Product): FAQ SIEMPRE CREA, nunca
// upsert (decisión confirmada #4 de la auditoría — no hay clave natural
// única para FAQ, `normalizedQuestion` es índice normal a propósito, no
// único). Consecuencia directa: acá NO hay chequeo de "code duplicado
// dentro del archivo" — 2 filas con la misma pregunta (o la misma
// pregunta normalizada) son AMBAS válidas y se importan como 2 FAQs
// distintas, exactamente el mismo criterio que ya aplica
// faq.service.js#crearFAQ() a una alta manual. Si el negocio quiere
// actualizar una FAQ existente en vez de crear una nueva, lo hace a mano
// vía CRUD (Etapa 5) — fuera de alcance de este importador en V1
// (documento §18 no pide upsert para FAQ, y la Etapa 9 del plan aprobado
// documentó esta asimetría explícitamente).
const MAX_FILAS = 5000;

const COLUMNAS_CONOCIDAS = {
  question: 'question',
  pregunta: 'question',
  answer: 'answer',
  respuesta: 'answer',
  category: 'category',
  categoria: 'category',
  aliases: 'aliases',
  alias: 'aliases',
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

// Mismo workaround que policyImport.service.js — ver el comentario
// completo ahí (escape `\uXXXX` como texto ASCII se corrompe al guardar
// este archivo).
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

const camposDesdeFila = (datosCrudos) => {
  const campos = {};
  const tieneValor = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  if (tieneValor(datosCrudos.question)) campos.question = String(datosCrudos.question).trim();
  if (tieneValor(datosCrudos.answer)) campos.answer = String(datosCrudos.answer).trim();
  if (tieneValor(datosCrudos.category)) campos.category = String(datosCrudos.category).trim().toLowerCase();
  if (tieneValor(datosCrudos.aliases)) campos.aliases = splitList(datosCrudos.aliases).map((a) => a.toLowerCase());
  if (tieneValor(datosCrudos.priority)) campos.priority = Number(datosCrudos.priority);
  if (tieneValor(datosCrudos.status)) campos.status = String(datosCrudos.status).trim().toLowerCase();
  if (tieneValor(datosCrudos.effectiveFrom)) campos.effectiveFrom = new Date(datosCrudos.effectiveFrom);
  if (tieneValor(datosCrudos.effectiveUntil)) campos.effectiveUntil = new Date(datosCrudos.effectiveUntil);
  if (tieneValor(datosCrudos.tags)) campos.tags = splitList(datosCrudos.tags).map((t) => t.toLowerCase());

  return campos;
};

const validarFila = (campos) => {
  const errores = [];

  if (!campos.question) errores.push('question vacía');
  else if (campos.question.length < 3) errores.push('question demasiado corta (mínimo 3 caracteres)');
  if (!campos.answer) errores.push('answer vacía');
  if (!campos.category) errores.push('category vacía');
  else if (!FAQ_CATEGORIES.includes(campos.category)) {
    errores.push(`category inválida: "${campos.category}" (valores válidos: ${FAQ_CATEGORIES.join(', ')})`);
  }

  if (campos.priority !== undefined && (!Number.isInteger(campos.priority) || campos.priority < 0 || campos.priority > 100)) {
    errores.push(`priority inválida: "${campos.priority}" (debe ser un entero entre 0 y 100)`);
  }
  if (campos.status !== undefined && !FAQ_STATUSES.includes(campos.status)) {
    errores.push(`status inválido: "${campos.status}" (valores válidos: ${FAQ_STATUSES.join(', ')})`);
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
 * A diferencia de policyImport/productImport, acá NO hay `accion`
 * "crear"/"actualizar" real — SIEMPRE es 'crear' (decisión #4). Se
 * mantiene el campo en la fila del preview de todos modos, con valor fijo
 * 'crear', para que el shape de la tabla de preview sea consistente entre
 * los 2 importadores del lado del panel de administración (Etapa 11).
 */
const parsearYValidarArchivo = async (file) => {
  const rowsCrudas = parsearArchivo(file);
  const columnasDesconocidas = new Set();

  const filas = rowsCrudas.map((rawRow, i) => {
    const numeroFila = i + 2;
    const datosCrudos = mapearFila(rawRow, columnasDesconocidas);
    const campos = camposDesdeFila(datosCrudos);
    const errores = validarFila(campos);

    return { numeroFila, accion: 'crear', campos, errores, advertencias: [] };
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
  const resultado = await parsearYValidarArchivo(file);
  logger.info(
    `FAQ_IMPORT_PREVIEW: business=${businessId} archivo=${file.originalname} filas=${resultado.resumen.totalFilas} validas=${resultado.resumen.validas} conErrores=${resultado.resumen.conErrores}`
  );
  return resultado;
};

/**
 * Siempre crea (documento de decisiones #4) — nunca findOneAndUpdate/upsert.
 * Cada fila válida se guarda con `new FAQ(...).save()` en vez de
 * `insertMany` para que faq.model.js#pre('validate') (normalizedQuestion,
 * dedupe de aliases/tags) corra fila por fila, igual que una alta manual
 * — insertMany saltearía los hooks de documento en versiones de Mongoose
 * donde eso importa, y acá si importa (documento §7.1).
 */
const confirmarImportacion = async (businessId, actor, file) => {
  logger.info(`FAQ_IMPORT_STARTED: business=${businessId} archivo=${file.originalname} actor=${actor?._id}`);

  const { filas, resumen } = await parsearYValidarArchivo(file);
  const filasValidas = filas.filter((f) => f.errores.length === 0);

  let creados = 0;
  const erroresEscritura = [];

  for (const fila of filasValidas) {
    try {
      // eslint-disable-next-line no-await-in-loop -- cada fila es una
      // escritura independiente (siempre crea, nunca upsert).
      const faq = new FAQ({
        ...fila.campos,
        business: businessId,
        source: { type: 'import', reference: file.originalname },
        createdBy: actor?._id ?? null,
        updatedBy: actor?._id ?? null,
      });
      await faq.save();
      creados += 1;
    } catch (err) {
      erroresEscritura.push({ numeroFila: fila.numeroFila, error: err.message });
    }
  }

  const resultado = {
    resumen: {
      totalFilas: resumen.totalFilas,
      nuevos: creados,
      actualizados: 0,
      erroresValidacion: resumen.conErrores,
      erroresEscritura: erroresEscritura.length,
    },
    erroresValidacion: filas
      .filter((f) => f.errores.length > 0)
      .map((f) => ({ numeroFila: f.numeroFila, errores: f.errores })),
    erroresEscritura,
  };

  logger.info(
    `FAQ_IMPORT_COMPLETED: business=${businessId} archivo=${file.originalname} nuevos=${creados} erroresValidacion=${resumen.conErrores} erroresEscritura=${erroresEscritura.length}`
  );

  return resultado;
};

module.exports = {
  MAX_FILAS,
  previsualizarImportacion,
  confirmarImportacion,
};
