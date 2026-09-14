const subscriptionService = require('../modules/subscriptions/subscription.service');

const requireCapability = (capability, predicate = () => true) => async (req, _res, next) => {
  try {
    if (predicate(req)) await subscriptionService.assertCapability(req.businessId, capability);
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireCapability };
