const service    = require('./subscription.service');
const { respuestaExito } = require('../../utils/response');
const { AppError }       = require('../../middleware/error.middleware');

// ─── Protected endpoints ──────────────────────────────────────────────────────

const getPlans = async (req, res, next) => {
  try {
    const plans = await service.getPlans();
    return respuestaExito(res, { message: 'Planes obtenidos', data: { plans } });
  } catch (err) { next(err); }
};

const getCurrentSubscription = async (req, res, next) => {
  try {
    const subscription = await service.getCurrentSubscription(req.businessId);
    return respuestaExito(res, { message: 'Suscripción actual', data: { subscription } });
  } catch (err) { next(err); }
};

const stripeSubscribe = async (req, res, next) => {
  try {
    const { planName, paymentMethodId } = req.body;
    if (!planName || !paymentMethodId) throw new AppError('planName y paymentMethodId son requeridos', 400);
    const result = await service.createStripeSubscription(req.businessId, planName, paymentMethodId);
    return respuestaExito(res, { statusCode: 201, message: 'Suscripción Stripe creada', data: result });
  } catch (err) { next(err); }
};

const mercadopagoSubscribe = async (req, res, next) => {
  try {
    const { planName, payerEmail } = req.body;
    if (!planName || !payerEmail) throw new AppError('planName y payerEmail son requeridos', 400);
    const result = await service.createMercadoPagoSubscription(req.businessId, planName, payerEmail);
    return respuestaExito(res, { statusCode: 201, message: 'Preferencia de suscripción MP creada', data: result });
  } catch (err) { next(err); }
};

const cancelSubscription = async (req, res, next) => {
  try {
    const atPeriodEnd = req.body.atPeriodEnd !== false;
    const result = await service.cancelSubscription(req.businessId, atPeriodEnd);
    return respuestaExito(res, { message: result.message, data: null });
  } catch (err) { next(err); }
};

const checkLeadLimit = async (req, res, next) => {
  try {
    const result = await service.checkLeadLimit(req.businessId);
    return respuestaExito(res, { message: 'Límite de leads verificado', data: result });
  } catch (err) { next(err); }
};

// ─── MP callback (redirect from MP after payment) ────────────────────────────

const mpCallback = async (req, res, next) => {
  try {
    const { preapproval_id, status } = req.query;
    const redirectBase = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${redirectBase}/dashboard/billing?provider=mercadopago&status=${status || 'pending'}&sub_id=${preapproval_id || ''}`);
  } catch (err) { next(err); }
};

// ─── Public webhook handlers (called from webhook.routes.js) ─────────────────

const stripeWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'] || '';
    const result    = await service.handleStripeWebhook(req.rawBody, signature);
    return res.status(200).json({ received: true, type: result.type });
  } catch (err) {
    if (err.type === 'StripeSignatureVerificationError') {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    next(err);
  }
};

const mercadopagoWebhook = async (req, res, next) => {
  try {
    res.status(200).json({ received: true });
    await service.handleMercadoPagoWebhook(req.body).catch(e =>
      console.error('[mp webhook]', e.message)
    );
  } catch (err) { next(err); }
};

module.exports = {
  getPlans,
  getCurrentSubscription,
  stripeSubscribe,
  mercadopagoSubscribe,
  cancelSubscription,
  checkLeadLimit,
  mpCallback,
  stripeWebhook,
  mercadopagoWebhook,
};
