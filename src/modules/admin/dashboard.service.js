const mongoose = require('mongoose');
const Business     = require('../businesses/business.model');
const User         = require('../users/user.model');
const Lead         = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const Automation   = require('../automations/automation.model');
const Subscription = require('../subscriptions/subscription.model');
const Plan         = require('../subscriptions/plan.model');

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

const getRevenueStats = async () => {
  const monthStart = startOf('month');

  const [plans, allSubs, newThisMonth, canceledThisMonth, subsByProvider] = await Promise.all([
    Plan.find({ isActive: true }),
    Subscription.find({ status: { $in: ['active', 'trialing'] } }).populate('plan', 'price name'),
    Subscription.countDocuments({ createdAt: { $gte: monthStart } }),
    Subscription.countDocuments({ status: 'canceled', canceledAt: { $gte: monthStart } }),
    Subscription.aggregate([
      { $group: { _id: '$provider', count: { $sum: 1 } } },
    ]),
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

module.exports = { getGlobalStats, getBusinessStats, getRevenueStats, getActivityFeed };
