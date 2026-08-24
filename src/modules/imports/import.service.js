const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const Pipeline = require('../pipeline/pipeline.model');
const Import = require('./import.model');
const subscriptionService = require('../subscriptions/subscription.service');
const { AppError } = require('../../middleware/error.middleware');
const { normalizeToE164 } = require('../../utils/phone');
const logger = require('../../utils/logger');

const VALID_STAGES = ['new', 'contacted', 'interested', 'proposal', 'negotiation', 'won', 'lost'];
const VALID_SOURCES = ['manual', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral', 'website', 'csv_import', 'other'];

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

const mapearFila = (row, columnMapping) => {
  const mapped = {};
  for (const [sourceCol, targetField] of Object.entries(columnMapping)) {
    const val = row[sourceCol];
    if (val !== undefined && String(val).trim() !== '') {
      mapped[targetField] = String(val).trim();
    }
  }
  return mapped;
};

const validarFila = (rowData, rowNum) => {
  const errors = [];

  if (!rowData.name) {
    errors.push({ row: rowNum, field: 'name', value: '', message: 'El campo "nombre" es requerido' });
  }

  if (rowData.email && !/^\S+@\S+\.\S+$/.test(rowData.email)) {
    errors.push({ row: rowNum, field: 'email', value: rowData.email, message: 'Email inválido' });
  }

  if (rowData.pipelineStage && !VALID_STAGES.includes(rowData.pipelineStage)) {
    errors.push({ row: rowNum, field: 'pipelineStage', value: rowData.pipelineStage, message: `Etapa inválida. Valores aceptados: ${VALID_STAGES.join(', ')}` });
  }

  // Corregir source inválida en lugar de error
  if (rowData.source && !VALID_SOURCES.includes(rowData.source)) {
    rowData.source = 'csv_import';
  }

  return errors;
};

const procesarImportacion = async (businessId, actorId, { file, columnMapping = {}, defaults = {} }) => {
  const startedAt = new Date();
  const ext = file.originalname.split('.').pop().toLowerCase();

  let rows;
  if (ext === 'csv') {
    rows = parsearCSV(file.buffer);
  } else if (['xlsx', 'xls'].includes(ext)) {
    rows = parsearXLSX(file.buffer);
  } else {
    throw new AppError('Formato no soportado. Use CSV, XLSX o XLS', 400);
  }

  if (!rows.length) throw new AppError('El archivo no contiene filas de datos', 400);

  const importRecord = await Import.create({
    business: businessId,
    createdBy: actorId,
    fileName: file.originalname,
    fileType: ext === 'xls' ? 'xls' : ext,
    fileSize: file.size,
    status: 'processing',
    totalRows: rows.length,
    columnMapping,
    defaults,
    startedAt,
  });

  let pipeline = await Pipeline.findOne({ business: businessId, isDefault: true, isActive: true });
  if (!pipeline) pipeline = await Pipeline.createDefault(businessId, actorId);

  const defaultStage = defaults.pipelineStage || 'new';
  const defaultSource = defaults.source || 'csv_import';
  const importBatch = importRecord._id.toString();

  // Obtener emails ya existentes para detectar duplicados
  const existentes = await Lead.find({ business: businessId, isDeleted: false, email: { $exists: true, $ne: null, $ne: '' } })
    .select('email')
    .lean();
  const emailsExistentes = new Set(existentes.map((l) => l.email.toLowerCase()));

  const errores = [];
  const leadsAInsertar = [];
  const rowNumsAInsertar = []; // paralelo a leadsAInsertar — permite reportar el rowNum real si insertMany rechaza un doc puntual (ver catch de abajo)
  const emailsEnLote = new Set();
  let duplicateCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +1 header, +1 base-1
    const usarMapping = Object.keys(columnMapping).length > 0;
    const rowData = usarMapping ? mapearFila(rows[i], columnMapping) : { ...rows[i] };

    const rowErrors = validarFila(rowData, rowNum);
    if (rowErrors.length) {
      errores.push(...rowErrors);
      continue;
    }

    // Detección de duplicados por email
    if (rowData.email) {
      const emailLower = rowData.email.toLowerCase();
      if (emailsExistentes.has(emailLower) || emailsEnLote.has(emailLower)) {
        duplicateCount++;
        continue;
      }
      emailsEnLote.add(emailLower);
    }

    leadsAInsertar.push({
      business: businessId,
      name: rowData.name,
      email: rowData.email ? rowData.email.toLowerCase() : undefined,
      // Lead.insertMany() (abajo) NO dispara el pre('save') de
      // lead.model.js — a diferencia de crearLead()/processGupshupMessage(),
      // un lead importado quedaba con el phone tal cual venía en el
      // archivo (crudo, sin normalizar). Se normaliza acá, antes del
      // insertMany, con la misma normalizeToE164() que usa el pre('save'),
      // mismo criterio que ya se corrigió para creación manual (Paso 1) y
      // WhatsApp entrante (fix/webhook-phone-normalization-lookup).
      phone: rowData.phone ? normalizeToE164(rowData.phone) : undefined,
      company: rowData.company || undefined,
      position: rowData.position || undefined,
      source: rowData.source || defaultSource,
      pipelineStage: rowData.pipelineStage || defaultStage,
      pipeline: pipeline._id,
      tags: defaults.tags || [],
      assignedTo: defaults.assignedTo || undefined,
      potentialValue: rowData.potentialValue ? Number(rowData.potentialValue) || 0 : 0,
      importBatch,
      stageChangedAt: new Date(),
      activity: [
        {
          type: 'imported',
          description: `Lead importado desde ${file.originalname}`,
          performedBy: actorId,
          performedByName: 'Importación',
          meta: { importBatch, fileName: file.originalname },
        },
      ],
    });
    rowNumsAInsertar.push(rowNum);
  }

  // Bloqueo duro de plan (auditoría de pricing del 23/ago/2026) — rechaza
  // el archivo ENTERO si excede el cupo restante, antes de insertar nada.
  // No se trunca ni se inserta parcial: mezclar "rechazado por cuota" con
  // "rechazado por datos inválidos" en el mismo reporte sería confuso. El
  // Import queda 'failed' vía la misma lógica de status de abajo (línea
  // ~230) — no hace falta un status nuevo ni dejarlo colgado en
  // 'processing'.
  if (leadsAInsertar.length) {
    const { current, limit } = await subscriptionService.checkLeadLimit(businessId);
    if (limit !== -1 && current + leadsAInsertar.length > limit) {
      const disponibles = Math.max(0, limit - current);
      errores.push({
        row: null,
        field: 'plan',
        value: String(leadsAInsertar.length),
        message: `Este archivo tiene ${leadsAInsertar.length} leads válidos, pero tu plan solo permite ${disponibles} más (ya tenés ${current}/${limit} leads activos). Reducí el archivo, cerrá oportunidades viejas, o subí de plan.`,
      });
      leadsAInsertar.length = 0; // rechazo total del archivo — no se inserta nada
    }
  }

  let successCount = 0;
  if (leadsAInsertar.length) {
    let inserted;
    try {
      inserted = await Lead.insertMany(leadsAInsertar, { ordered: false });
    } catch (err) {
      // insertMany({ordered:false}) intenta TODOS los docs — si alguno
      // choca (ej. E11000 del índice único {business,phone}, más probable
      // ahora que el phone llega normalizado, ver commit anterior),
      // Mongoose lanza un MongoBulkWriteError con los que SÍ se
      // insertaron en err.insertedDocs y el detalle de los que fallaron
      // en err.writeErrors. Antes, este catch no existía: la excepción se
      // propagaba sin capturar, el Import quedaba colgado en 'processing'
      // para siempre y se perdía de vista qué parte del lote sí se había
      // insertado.
      if (!err.insertedDocs) throw err; // no es un fallo parcial de escritura conocido — no hay nada que rescatar, se relanza tal cual
      inserted = err.insertedDocs;
      for (const we of err.writeErrors || []) {
        const rowData = leadsAInsertar[we.index];
        const esDuplicado = (we.err?.code ?? we.code) === 11000;
        errores.push({
          row: rowNumsAInsertar[we.index] ?? null,
          field: 'phone',
          value: rowData?.phone || '',
          message: esDuplicado
            ? 'Ya existe otro lead con este teléfono en este negocio'
            : (we.err?.errmsg || we.errmsg || 'No se pudo insertar este lead'),
        });
      }
      logger.error(`[import] insertMany parcial: ${inserted.length}/${leadsAInsertar.length} insertados, ${(err.writeErrors || []).length} fallaron`, { importId: importRecord._id.toString() });
    }
    successCount = inserted.length;

    // Mismo criterio que crearLead() (lead.service.js): un lead importado
    // no pasa por ningún flujo que le cree una Conversation por su cuenta
    // (eso solo pasa con un mensaje de WhatsApp entrante) — se crea acá,
    // en lote, para que el panel de chat tenga un conversationId listo
    // para usar sin esperar al primer mensaje real.
    if (inserted.length) {
      try {
        await Conversation.insertMany(
          inserted.map((lead) => ({
            business:  businessId,
            lead:      lead._id,
            channel:   'manual',
            status:    'active',
            aiEnabled: true,
          })),
          { ordered: false }
        );
      } catch (err) {
        // Los leads YA se insertaron correctamente — un fallo acá no debe
        // perder ese progreso ni dejar el Import colgado. Se loguea, no
        // se relanza (mismo criterio de "nunca perder trabajo ya hecho"
        // que el resto de este flujo).
        logger.error(`[import] fallo creando Conversations en lote: ${err.message}`, { importId: importRecord._id.toString() });
      }
    }
  }

  const completedAt = new Date();
  const status = errores.length === 0 ? 'completed' : successCount > 0 ? 'partial' : 'failed';

  await Import.findByIdAndUpdate(importRecord._id, {
    status,
    successCount,
    errorCount: errores.length,
    duplicateCount,
    errors: errores,
    completedAt,
    processingTimeMs: completedAt - startedAt,
  });

  return Import.findById(importRecord._id);
};

const listarImportaciones = async (businessId, { page = 1, limit = 20 }) => {
  const skip = (Number(page) - 1) * Number(limit);
  const [imports, total] = await Promise.all([
    Import.find({ business: businessId })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select('-errors'),
    Import.countDocuments({ business: businessId }),
  ]);
  return { imports, total };
};

const obtenerImportacion = async (businessId, importId) => {
  const importRecord = await Import.findOne({ _id: importId, business: businessId })
    .populate('createdBy', 'name email');
  if (!importRecord) throw new AppError('Importación no encontrada', 404);
  return importRecord;
};

module.exports = { procesarImportacion, listarImportaciones, obtenerImportacion };
