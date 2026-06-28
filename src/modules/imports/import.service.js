const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Import = require('./import.model');
const { AppError } = require('../../middleware/error.middleware');

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
      phone: rowData.phone || undefined,
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
  }

  let successCount = 0;
  if (leadsAInsertar.length) {
    const inserted = await Lead.insertMany(leadsAInsertar, { ordered: false });
    successCount = inserted.length;
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
