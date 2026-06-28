const mongoose = require('mongoose');
const Lead         = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildDateFilter = (startDate, endDate) => {
  const filter = {};
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate)   filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  }
  return filter;
};

const escapeCSV = (val) => {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const toCSV = (rows, headers) => {
  const headerLine = headers.map((h) => escapeCSV(h.label)).join(',');
  const lines = rows.map((row) =>
    headers.map((h) => escapeCSV(row[h.key])).join(',')
  );
  return [headerLine, ...lines].join('\n');
};

// ─── 1. getLeadsReport ────────────────────────────────────────────────────────

const getLeadsReport = async (businessId, { startDate, endDate, source, stage, page = 1, limit = 50 } = {}) => {
  const id     = new mongoose.Types.ObjectId(businessId);
  const skip   = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const lim    = parseInt(limit, 10);

  const match = { business: id, isDeleted: false, ...buildDateFilter(startDate, endDate) };
  if (source) match.source        = source;
  if (stage)  match.pipelineStage = stage;

  const [leads, total, bySource, byStage, byTemp] = await Promise.all([
    Lead.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate('assignedTo', 'name')
      .select('name email phone company source pipelineStage temperature tags potentialValue currency assignedTo createdAt'),
    Lead.countDocuments(match),
    Lead.aggregate([
      { $match: match },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: match },
      { $group: { _id: '$pipelineStage', count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: match },
      { $group: { _id: '$temperature', count: { $sum: 1 } } },
    ]),
  ]);

  const toMap = (arr) => arr.reduce((acc, { _id, count }) => ({ ...acc, [_id || 'unknown']: count }), {});

  return {
    leads,
    summary: {
      total,
      bySource:      toMap(bySource),
      byStage:       toMap(byStage),
      byTemperature: toMap(byTemp),
    },
    pagination: {
      page: parseInt(page, 10),
      limit: lim,
      total,
      totalPages: Math.ceil(total / lim),
    },
  };
};

// ─── 2. getConversionsReport ──────────────────────────────────────────────────

const getConversionsReport = async (businessId, { startDate, endDate } = {}) => {
  const id    = new mongoose.Types.ObjectId(businessId);
  const match = { business: id, isDeleted: false, ...buildDateFilter(startDate, endDate) };

  const [totalLeads, wonLeads, wonValue, byMonth] = await Promise.all([
    Lead.countDocuments(match),
    Lead.countDocuments({ ...match, pipelineStage: 'won' }),
    Lead.aggregate([
      { $match: { ...match, pipelineStage: 'won' } },
      { $group: { _id: null, total: { $sum: '$potentialValue' } } },
    ]),
    Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            year:  { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          total: { $sum: 1 },
          won:   { $sum: { $cond: [{ $eq: ['$pipelineStage', 'won'] }, 1, 0] } },
          value: { $sum: { $cond: [{ $eq: ['$pipelineStage', 'won'] }, '$potentialValue', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
  ]);

  const conversionRate = totalLeads > 0
    ? parseFloat(((wonLeads / totalLeads) * 100).toFixed(2))
    : 0;

  return {
    summary: {
      totalLeads,
      wonLeads,
      conversionRate,
      wonValue: wonValue[0]?.total || 0,
    },
    byMonth: byMonth.map(({ _id, total, won, value }) => ({
      period: `${_id.year}-${String(_id.month).padStart(2, '0')}`,
      total,
      won,
      conversionRate: total > 0 ? parseFloat(((won / total) * 100).toFixed(2)) : 0,
      value,
    })),
  };
};

// ─── 3. getAIUsageReport ─────────────────────────────────────────────────────

const getAIUsageReport = async (businessId, { startDate, endDate } = {}) => {
  const id    = new mongoose.Types.ObjectId(businessId);
  const match = { business: id, isDeleted: false, ...buildDateFilter(startDate, endDate) };

  const [totalConvs, tokenAgg, byStatus, byChannel, byMonth] = await Promise.all([
    Conversation.countDocuments(match),
    Conversation.aggregate([
      { $match: match },
      { $group: { _id: null, tokens: { $sum: '$totalTokensUsed' }, messages: { $sum: { $size: '$messages' } } } },
    ]),
    Conversation.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Conversation.aggregate([
      { $match: match },
      { $group: { _id: '$channel', count: { $sum: 1 } } },
    ]),
    Conversation.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            year:  { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          conversations: { $sum: 1 },
          tokens:        { $sum: '$totalTokensUsed' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
  ]);

  const totalTokens  = tokenAgg[0]?.tokens   || 0;
  const totalMessages = tokenAgg[0]?.messages || 0;
  const avgTokens    = totalConvs > 0 ? parseFloat((totalTokens / totalConvs).toFixed(0)) : 0;
  const toMap        = (arr) => arr.reduce((acc, { _id, count }) => ({ ...acc, [_id || 'unknown']: count }), {});

  return {
    summary: {
      totalConversations: totalConvs,
      totalTokensUsed:    totalTokens,
      totalMessages,
      avgTokensPerConversation: avgTokens,
    },
    byStatus:  toMap(byStatus),
    byChannel: toMap(byChannel),
    byMonth: byMonth.map(({ _id, conversations, tokens }) => ({
      period: `${_id.year}-${String(_id.month).padStart(2, '0')}`,
      conversations,
      tokens,
    })),
  };
};

// ─── 4. exportLeadsCSV ────────────────────────────────────────────────────────

const LEAD_CSV_HEADERS = [
  { key: 'name',          label: 'Nombre' },
  { key: 'email',         label: 'Email' },
  { key: 'phone',         label: 'Teléfono' },
  { key: 'company',       label: 'Empresa' },
  { key: 'source',        label: 'Fuente' },
  { key: 'pipelineStage', label: 'Etapa' },
  { key: 'temperature',   label: 'Temperatura' },
  { key: 'tags',          label: 'Etiquetas' },
  { key: 'potentialValue',label: 'Valor potencial' },
  { key: 'currency',      label: 'Moneda' },
  { key: 'assignedTo',    label: 'Asignado a' },
  { key: 'createdAt',     label: 'Fecha creación' },
];

const exportLeadsCSV = async (businessId, { startDate, endDate, source, stage } = {}) => {
  const id    = new mongoose.Types.ObjectId(businessId);
  const match = { business: id, isDeleted: false, ...buildDateFilter(startDate, endDate) };
  if (source) match.source        = source;
  if (stage)  match.pipelineStage = stage;

  const leads = await Lead.find(match)
    .sort({ createdAt: -1 })
    .limit(10000)
    .populate('assignedTo', 'name')
    .select('name email phone company source pipelineStage temperature tags potentialValue currency assignedTo createdAt');

  const rows = leads.map((l) => ({
    name:          l.name,
    email:         l.email || '',
    phone:         l.phone || '',
    company:       l.company || '',
    source:        l.source,
    pipelineStage: l.pipelineStage,
    temperature:   l.temperature,
    tags:          (l.tags || []).join('; '),
    potentialValue: l.potentialValue || 0,
    currency:      l.currency,
    assignedTo:    l.assignedTo?.name || '',
    createdAt:     l.createdAt ? l.createdAt.toISOString().slice(0, 10) : '',
  }));

  return toCSV(rows, LEAD_CSV_HEADERS);
};

module.exports = { getLeadsReport, getConversionsReport, getAIUsageReport, exportLeadsCSV };
