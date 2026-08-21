const service = require('./push.service');
const { validateBody } = require('../../shared/utils/validate');
const { registerTokenSchema, unregisterTokenSchema } = require('./push.validator');
const { respuestaExito } = require('../../utils/response');

// POST /api/v1/push/register
const register = async (req, res, next) => {
  try {
    const data = await validateBody(registerTokenSchema, req.body);
    const pushToken = await service.registrarToken(req.user._id, req.businessId, data);
    return respuestaExito(res, {
      statusCode: 201,
      message: 'Token de push registrado exitosamente',
      data: { pushToken },
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/v1/push/unregister
const unregister = async (req, res, next) => {
  try {
    const data = await validateBody(unregisterTokenSchema, req.body);
    await service.desregistrarToken(req.user._id, data.token);
    return respuestaExito(res, { message: 'Token de push desregistrado exitosamente' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, unregister };
