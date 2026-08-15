/**
 * Reporte de solo lectura: formatos de Lead.phone y duplicados por "núcleo
 * numérico" (últimos 9 dígitos, ignorando +/espacios/separadores/código de país).
 *
 * NO normaliza ni fusiona nada — solo reporta. Ver Implementation Blueprint
 * §7 (Phone normalization y deduplicación) y §5.2 (los ~15 duplicados de
 * Myrel Company).
 *
 * Uso:
 *   node scripts/report-phone-duplicates.js
 *   railway run node scripts/report-phone-duplicates.js   (contra producción)
 *
 * Salida: backups/<timestamp>/phone-duplicates-report.json (+ resumen en consola).
 * No escribe nada en la base de datos.
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Lead = require('../src/modules/leads/lead.model');
const Conversation = require('../src/modules/ai/conversation.model');
const Business = require('../src/modules/businesses/business.model');

function classifyFormat(raw) {
  if (!raw || !raw.trim()) return 'vacio';
  const v = raw.trim();
  if (/^\+\d{8,15}$/.test(v)) return 'E.164 (+cod_pais...)';
  if (/\s/.test(v)) return 'con_espacios';
  if (/[()\-]/.test(v)) return 'con_separadores';
  if (/^\d{8,15}$/.test(v)) return 'solo_digitos_sin_+';
  return 'otro_no_reconocido';
}

function numericCore(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  return digits.slice(-9); // últimos 9 dígitos — largo de un celular peruano sin código de país
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const leads = await Lead.find({}, '_id business phone name').lean();
  const businesses = await Business.find({}, '_id name').lean();
  const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

  // ── 1. Distribución por formato ──────────────────────────────────────────
  const formatCounts = {};
  for (const lead of leads) {
    const fmt = classifyFormat(lead.phone);
    formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
  }

  // ── 2. Agrupar por (business, núcleo numérico) ───────────────────────────
  const groups = new Map(); // key: `${business}|${core}` → leads[]
  for (const lead of leads) {
    const core = numericCore(lead.phone);
    if (!core || core.length < 8) continue; // teléfono vacío/basura, no agrupable
    const key = `${lead.business}|${core}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  // ── 3. Enriquecer con conteo de conversaciones por lead ──────────────────
  const leadIds = duplicateGroups.flat().map((l) => l._id);
  const convCounts = await Conversation.aggregate([
    { $match: { lead: { $in: leadIds } } },
    { $group: { _id: '$lead', count: { $sum: 1 } } },
  ]);
  const convCountByLead = new Map(convCounts.map((c) => [String(c._id), c.count]));

  const report = duplicateGroups.map((group) => ({
    business: String(group[0].business),
    businessName: businessNameById.get(String(group[0].business)) || '(desconocido)',
    phoneCore: numericCore(group[0].phone),
    variantes: group.map((l) => l.phone),
    leadIds: group.map((l) => String(l._id)),
    leadNames: group.map((l) => l.name),
    countConversaciones: group.map((l) => convCountByLead.get(String(l._id)) || 0),
  }));

  // ── 4. Resumen por negocio ────────────────────────────────────────────────
  const byBusiness = {};
  for (const row of report) {
    byBusiness[row.businessName] = (byBusiness[row.businessName] || 0) + 1;
  }

  // ── 5. Guardar reporte ────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'phone-duplicates-report.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), totalLeads: leads.length, formatCounts, duplicateGroupsCount: report.length, byBusiness, groups: report }, null, 2)
  );

  logger.info('── Distribución de formatos de Lead.phone ──');
  for (const [fmt, count] of Object.entries(formatCounts)) logger.info(`  ${fmt}: ${count}`);
  logger.info(`── Grupos duplicados (mismo núcleo numérico, mismo negocio): ${report.length} ──`);
  for (const [biz, count] of Object.entries(byBusiness)) logger.info(`  ${biz}: ${count} grupo(s)`);
  logger.info(`✓ Reporte completo guardado en: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error generando reporte de duplicados:', err.message);
  process.exit(1);
});
