const mongoose = require('mongoose');
const Business           = require('../businesses/business.model');
const User               = require('../users/user.model');
const Lead               = require('../leads/lead.model');
const Conversation       = require('../ai/conversation.model');
const Automation         = require('../automations/automation.model');
const Subscription       = require('../subscriptions/subscription.model');
const Plan               = require('../subscriptions/plan.model');
const WhatsAppConnection = require('../whatsapp/whatsappConnection.model');
const { PIPELINE_STAGES, STAGE_LABELS } = Lead;
const { OPENAI_MODEL } = require('../../config/env');
const { getPricing, getBlendedRate } = require('../../config/aiPricing');

const toCountMap = (arr) =>
  arr.reduce((acc, { _id, count }) => ({ ...acc, [_id || 'unknown']: count }), {});

// ─── Helpers de rango de fechas ──────────────────────────────────────────────

const startOf = (unit) => {
  const now = new Date();
  if (unit === 'day')  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (unit === 'week') {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(now.getFullYear(), now.getMonth(), diff);
  }
  if (unit === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (unit === 'year')  return new Date(now.getFullYear(), 0, 1);
  return new Date(0);
};

// ─── 1. getGlobalStats ────────────────────────────────────────────────────────

const getGlobalStats = async () => {
  const now        = new Date();
  const monthStart = startOf('month');
  const weekStart  = startOf('week');
  const dayStart   = startOf('day');

  const [
    totalBusinesses,
    activeBusinessesMonth,
    totalUsers,
    totalLeads,
    totalConversations,
    activeSubscriptions,
    leadsToday,
    leadsWeek,
    leadsMonth,
    conversionsMonth,
  ] = await Promise.all([
    Business.countDocuments(),
    Business.countDocuments({ isActive: true, createdAt: { $gte: monthStart } }),
    User.countDocuments({ isActive: true }),
    Lead.countDocuments({ isDeleted: false }),
    Conversation.countDocuments({ isDeleted: false }),
    Subscription.find({ status: { $in: ['active', 'trialing'] } }).populate('plan', 'price planName'),
    Lead.countDocuments({ isDeleted: false, createdAt: { $gte: dayStart } }),
    Lead.countDocuments({ isDeleted: false, createdAt: { $gte: weekStart } }),
    Lead.countDocuments({ isDeleted: false, createdAt: { $gte: monthStart } }),
    Lead.countDocuments({ isDeleted: false, pipelineStage: 'won', updatedAt: { $gte: monthStart } }),
  ]);

  const mrr = activeSubscriptions.reduce((sum, sub) => {
    const price = sub.plan?.price || 0;
    return sum + price;
  }, 0);

  return {
    businesses: {
      total: totalBusinesses,
      activeThisMonth: activeBusinessesMonth,
    },
    users:         { total: totalUsers },
    leads: {
      total:          totalLeads,
      today:          leadsToday,
      thisWeek:       leadsWeek,
      thisMonth:      leadsMonth,
      conversionsMonth,
    },
    conversations: { total: totalConversations },
    revenue:       { mrr: parseFloat(mrr.toFixed(2)) },
  };
};

// ─── 2. getBusinessStats ─────────────────────────────────────────────────────

const getBusinessStats = async (businessId) => {
  const id         = new mongoose.Types.ObjectId(businessId);
  const monthStart = startOf('month');

  const [
    totalLeads,
    activeLeads,
    wonLeads,
    lostLeads,
    leadsByStage,
    leadsByTemp,
    leadsBySource,
    activeConvs,
    tokenUsage,
    activeAutomations,
    automationExecutions,
    activeUsers,
    subscription,
  ] = await Promise.all([
    Lead.countDocuments({ business: id, isDeleted: false }),
    Lead.countDocuments({ business: id, isDeleted: false, isArchived: false }),
    Lead.countDocuments({ business: id, isDeleted: false, pipelineStage: 'won' }),
    Lead.countDocuments({ business: id, isDeleted: false, pipelineStage: 'lost' }),
    Lead.aggregate([
      { $match: { business: id, isDeleted: false } },
      { $group: { _id: '$pipelineStage', count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { business: id, isDeleted: false } },
      { $group: { _id: '$temperature', count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { business: id, isDeleted: false } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    Conversation.countDocuments({ business: id, isDeleted: false, status: 'active' }),
    Conversation.aggregate([
      { $match: { business: id, isDeleted: false, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, tokens: { $sum: '$totalTokensUsed' } } },
    ]),
    Automation.countDocuments({ business: id, isActive: true, isDeleted: false }),
    Automation.aggregate([
      { $match: { business: id, isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$stats.totalExecutions' }, success: { $sum: '$stats.successCount' } } },
    ]),
    User.countDocuments({ business: id, isActive: true }),
    Subscription.findOne({ business: id }).populate('plan', 'name displayName price limits'),
  ]);

  const arrayToMap = (arr) =>
    arr.reduce((acc, { _id, count }) => ({ ...acc, [_id]: count }), {});

  return {
    leads: {
      total:   totalLeads,
      active:  activeLeads,
      won:     wonLeads,
      lost:    lostLeads,
      byStage: arrayToMap(leadsByStage),
      byTemperature: arrayToMap(leadsByTemp),
      bySource: arrayToMap(leadsBySource),
    },
    ai: {
      activeConversations: activeConvs,
      tokensUsedThisMonth: tokenUsage[0]?.tokens || 0,
    },
    automations: {
      active:          activeAutomations,
      totalExecutions: automationExecutions[0]?.total || 0,
      successCount:    automationExecutions[0]?.success || 0,
    },
    users:        { active: activeUsers },
    subscription: subscription
      ? {
          plan:     subscription.planName,
          status:   subscription.status,
          provider: subscription.provider,
          details:  subscription.plan,
        }
      : null,
  };
};

// ─── 3. getRevenueStats ───────────────────────────────────────────────────────

// Reconstruye el MRR de los últimos N cierres de mes a partir de createdAt/canceledAt.
// Aproximación: asume que una suscripción generó ingreso todo el tiempo entre su
// creación y su cancelación (no hay historial de cambios de plan/pausas guardado).
const getMrrHistory = async (monthsBack) => {
  const allSubs = await Subscription.find({}, 'createdAt canceledAt planName plan').populate('plan', 'price');
  const now = new Date();
  const history = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
    const period = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}`;

    const mrr = allSubs.reduce((sum, sub) => {
      const existedByMonthEnd = sub.createdAt <= monthEnd;
      const notYetCanceled    = !sub.canceledAt || sub.canceledAt > monthEnd;
      return existedByMonthEnd && notYetCanceled ? sum + (sub.plan?.price || 0) : sum;
    }, 0);

    history.push({ period, mrr: parseFloat(mrr.toFixed(2)) });
  }

  return history;
};

const getRevenueStats = async ({ period = 'month', historyMonths = 6 } = {}) => {
  const monthStart = startOf('month');
  const periodStart = period === 'year' ? startOf('year') : monthStart;

  const [plans, allSubs, newThisMonth, canceledThisMonth, newInPeriod, canceledInPeriod, subsByProvider, history] = await Promise.all([
    Plan.find({ isActive: true }),
    Subscription.find({ status: { $in: ['active', 'trialing'] } }).populate('plan', 'price name'),
    Subscription.countDocuments({ createdAt: { $gte: monthStart } }),
    Subscription.countDocuments({ status: 'canceled', canceledAt: { $gte: monthStart } }),
    Subscription.countDocuments({ createdAt: { $gte: periodStart } }),
    Subscription.countDocuments({ status: 'canceled', canceledAt: { $gte: periodStart } }),
    Subscription.aggregate([
      { $group: { _id: '$provider', count: { $sum: 1 } } },
    ]),
    getMrrHistory(Math.min(parseInt(historyMonths, 10) || 6, 24)),
  ]);

  const totalActive = await Subscription.countDocuments({ status: { $in: ['active', 'trialing'] } });

  const mrrByPlan = {};
  for (const sub of allSubs) {
    const planName = sub.planName || 'starter';
    const price    = sub.plan?.price || 0;
    mrrByPlan[planName] = (mrrByPlan[planName] || 0) + price;
  }

  const totalMrr   = Object.values(mrrByPlan).reduce((a, b) => a + b, 0);
  const churnRate  = totalActive > 0
    ? parseFloat(((canceledThisMonth / (totalActive + canceledThisMonth)) * 100).toFixed(2))
    : 0;

  const providerMap = subsByProvider.reduce((acc, { _id, count }) => ({ ...acc, [_id]: count }), {});

  return {
    mrr: {
      total:   parseFloat(totalMrr.toFixed(2)),
      byPlan:  mrrByPlan,
    },
    subscriptions: {
      active:          totalActive,
      newThisMonth,
      canceledThisMonth,
      churnRate,
      byProvider:      providerMap,
    },
    // Agregado según ?period= (default 'month'), sin afectar los campos de arriba
    period: {
      type:               period === 'year' ? 'year' : 'month',
      newSubscriptions:      newInPeriod,
      canceledSubscriptions: canceledInPeriod,
    },
    history, // serie mensual de MRR reconstruida, últimos `historyMonths` meses
  };
};

// ─── 4. getActivityFeed ───────────────────────────────────────────────────────

const getActivityFeed = async (businessId, limit = 20) => {
  const id  = new mongoose.Types.ObjectId(businessId);
  const cap = Math.min(parseInt(limit, 10) || 20, 100);

  const [recentLeads, recentConversations] = await Promise.all([
    Lead.find({ business: id, isDeleted: false })
      .sort({ updatedAt: -1 })
      .limit(cap)
      .select('name pipelineStage activity createdAt updatedAt'),
    Conversation.find({ business: id, isDeleted: false })
      .sort({ createdAt: -1 })
      .limit(Math.ceil(cap / 2))
      .populate('lead', 'name')
      .select('status channel createdAt lead'),
  ]);

  const events = [];

  for (const lead of recentLeads) {
    const lastActivity = lead.activity[lead.activity.length - 1];
    if (lastActivity) {
      events.push({
        type:        lastActivity.type,
        entity:      'lead',
        entityId:    lead._id,
        entityName:  lead.name,
        description: lastActivity.description || lastActivity.type,
        performedBy: lastActivity.performedByName || null,
        timestamp:   lastActivity.createdAt || lead.updatedAt,
      });
    } else {
      events.push({
        type:       'created',
        entity:     'lead',
        entityId:   lead._id,
        entityName: lead.name,
        description: `Lead creado: ${lead.name}`,
        timestamp:  lead.createdAt,
      });
    }
  }

  for (const conv of recentConversations) {
    events.push({
      type:       'conversation_started',
      entity:     'conversation',
      entityId:   conv._id,
      entityName: conv.lead?.name || 'Desconocido',
      description: `Conversación IA iniciada — canal: ${conv.channel}`,
      timestamp:  conv.createdAt,
    });
  }

  return events
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, cap);
};

// ─── 5. getGlobalUsersStats ───────────────────────────────────────────────────

const getGlobalUsersStats = async () => {
  const [total, active, byRoleAgg, byCountryAgg] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    User.aggregate([
      { $lookup: { from: 'roles', localField: 'role', foreignField: '_id', as: 'roleDoc' } },
      { $unwind: '$roleDoc' },
      { $group: { _id: '$roleDoc.slug', count: { $sum: 1 } } },
    ]),
    // "País" = país del negocio al que pertenece el usuario (User no tiene country propio)
    User.aggregate([
      { $lookup: { from: 'businesses', localField: 'business', foreignField: '_id', as: 'businessDoc' } },
      { $unwind: '$businessDoc' },
      { $group: { _id: '$businessDoc.country', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    total,
    active,
    byRole:    toCountMap(byRoleAgg),
    byCountry: toCountMap(byCountryAgg),
  };
};

// ─── 6. getGlobalBusinessesStats ──────────────────────────────────────────────

const getGlobalBusinessesStats = async () => {
  const [total, active, byCountryAgg, byPlanAgg] = await Promise.all([
    Business.countDocuments(),
    Business.countDocuments({ isActive: true }),
    Business.aggregate([{ $group: { _id: '$country', count: { $sum: 1 } } }]),
    Business.aggregate([{ $group: { _id: '$plan', count: { $sum: 1 } } }]),
  ]);

  return {
    total,
    active,
    byCountry: toCountMap(byCountryAgg),
    byPlan:    toCountMap(byPlanAgg),
  };
};

// ─── 7. getUsersTimeseries ─────────────────────────────────────────────────────

const getUsersTimeseries = async (range = '12m') => {
  const months = Math.min(parseInt(range, 10) || 12, 36);
  const since  = new Date();
  since.setMonth(since.getMonth() - (months - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id:   { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  return rows.map(({ _id, count }) => ({
    period:   `${_id.year}-${String(_id.month).padStart(2, '0')}`,
    newUsers: count,
  }));
};

// ─── 8. getAICostTimeseries ────────────────────────────────────────────────────
// Costo exacto para mensajes con metadata.promptTokens/completionTokens (desde el
// fix que empezó a guardarlos); tarifa combinada estimada para mensajes previos.

const getAICostTimeseries = async (range = '14d') => {
  const days  = Math.min(parseInt(range, 10) || 14, 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await Conversation.aggregate([
    { $unwind: '$messages' },
    { $match: { 'messages.role': 'assistant', 'messages.timestamp': { $gte: since } } },
    {
      $project: {
        day:              { $dateToString: { format: '%Y-%m-%d', date: '$messages.timestamp' } },
        tokens:           { $ifNull: ['$messages.tokens', 0] },
        promptTokens:     '$messages.metadata.promptTokens',
        completionTokens: '$messages.metadata.completionTokens',
      },
    },
    {
      $group: {
        _id:              '$day',
        totalTokens:      { $sum: '$tokens' },
        promptTokens:     { $sum: { $ifNull: ['$promptTokens', 0] } },
        completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
        // Tokens de días/mensajes SIN desglose guardado → van a tarifa combinada
        estimatedTokens:  { $sum: { $cond: [{ $eq: [{ $ifNull: ['$promptTokens', null] }, null] }, '$tokens', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const { input: inputRate, output: outputRate } = getPricing(OPENAI_MODEL);
  const blendedRate = getBlendedRate(OPENAI_MODEL);

  return rows.map((r) => {
    const exactCost = (r.promptTokens / 1_000_000) * inputRate + (r.completionTokens / 1_000_000) * outputRate;
    const estimatedCost = (r.estimatedTokens / 1_000_000) * blendedRate;

    return {
      date:              r._id,
      totalTokens:       r.totalTokens,
      estimatedCostUSD:  parseFloat((exactCost + estimatedCost).toFixed(4)),
      hasExactBreakdown: r.estimatedTokens === 0,
    };
  });
};

// ─── 9. getGlobalLeads (list | funnel) ────────────────────────────────────────

const buildGlobalLeadsFilter = ({ businessId, stage, channel, dateFrom, dateTo, search } = {}) => {
  const filter = { isDeleted: false };

  if (businessId) filter.business = businessId;
  if (stage) filter.pipelineStage = stage;
  if (channel) filter.source = channel; // Lead no tiene campo `channel`; se mapea a `source`

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  if (search) {
    const regex = { $regex: search.trim(), $options: 'i' };
    filter.$or = [{ name: regex }, { email: regex }, { phone: regex }, { company: regex }];
  }

  return filter;
};

const getGlobalLeadsFunnel = async (filters) => {
  const filter = buildGlobalLeadsFilter(filters);

  const rows = await Lead.aggregate([
    { $match: filter },
    { $group: { _id: '$pipelineStage', count: { $sum: 1 } } },
  ]);
  const countByStage = toCountMap(rows);

  return PIPELINE_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage] || stage,
    count: countByStage[stage] || 0,
  }));
};

const getGlobalLeadsList = async (filters, { page = 1, limit = 20 } = {}) => {
  const skip   = (page - 1) * limit;
  const filter = buildGlobalLeadsFilter(filters);

  const [leads, total] = await Promise.all([
    Lead.find(filter)
      .populate('business', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Lead.countDocuments(filter),
  ]);

  const items = leads.map((lead) => {
    const obj = lead.toObject({ virtuals: true });
    obj.businessName = lead.business?.name || null;
    obj.business      = lead.business?._id || lead.business;
    return obj;
  });

  return { items, total };
};

// ─── 10. getGlobalWhatsappConnections ─────────────────────────────────────────
// NOTA: la integración de WhatsApp es 100% simulada (isSimulated: true, v1.1).
// No existe todavía un registro de webhooks recibidos por conexión (eso vendrá
// con la integración real vía Gupshup Partner API, v1.2 / ticket #264467), por
// lo que `status` es el valor guardado en WhatsAppConnection y
// `lastWebhookReceivedAt` se devuelve como null hasta que esa data exista.

const getGlobalWhatsappConnections = async () => {
  const connections = await WhatsAppConnection.find({})
    .populate('business', 'name')
    .sort({ createdAt: -1 });

  const businessIds = connections.map((c) => c.business?._id).filter(Boolean);
  const subscriptions = await Subscription.find(
    { business: { $in: businessIds } },
    'business planName leadsUsedThisMonth'
  );
  const subByBusiness = subscriptions.reduce(
    (acc, sub) => ({ ...acc, [sub.business.toString()]: sub }),
    {}
  );

  return connections.map((conn) => {
    const sub = conn.business ? subByBusiness[conn.business._id.toString()] : null;

    return {
      connectionId: conn._id,
      businessId:   conn.business?._id || null,
      businessName: conn.business?.name || null,
      whatsappNumber: conn.phoneNumber,
      wabaId:       conn.wabaId,
      status:       conn.status,
      connectedAt:  conn.connectedAt,
      lastWebhookReceivedAt: null,
      isSimulated:  conn.isSimulated,
      plan:               sub?.planName || null,
      leadsUsedThisMonth: sub?.leadsUsedThisMonth ?? null,
    };
  });
};

module.exports = {
  getGlobalStats,
  getBusinessStats,
  getRevenueStats,
  getActivityFeed,
  getGlobalUsersStats,
  getGlobalBusinessesStats,
  getUsersTimeseries,
  getAICostTimeseries,
  getGlobalLeadsFunnel,
  getGlobalLeadsList,
  getGlobalWhatsappConnections,
};
