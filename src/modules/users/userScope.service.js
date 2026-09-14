const User = require('./user.model');
const { AppError } = require('../../middleware/error.middleware');

async function assertActiveUserInBusiness(userId, businessId) {
  if (!userId) return null;

  const user = await User.findOne({
    _id: userId,
    business: businessId,
    isActive: true,
  }).select('_id business');

  if (!user) {
    throw new AppError('El usuario asignado no pertenece al negocio o está inactivo', 400);
  }

  return user;
}

module.exports = { assertActiveUserInBusiness };
