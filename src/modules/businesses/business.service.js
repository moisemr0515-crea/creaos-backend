const Business = require('./business.model');
const { AppError } = require('../../middleware/error.middleware');

/**
 * Obtiene el negocio actual del usuario autenticado.
 */
const obtenerNegocioActual = async (businessId) => {
  const negocio = await Business.findById(businessId).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

/**
 * Actualiza datos principales del negocio (nombre, logo, industria, etc.).
 */
const actualizarNegocio = async (businessId, datos) => {
  const camposPermitidos = ['name', 'logo', 'industry', 'country', 'currency', 'phone', 'email', 'website', 'whatsappNumber', 'productDescription', 'averageTicket', 'targetCustomer'];
  const actualizacion = {};

  camposPermitidos.forEach((campo) => {
    if (datos[campo] !== undefined) actualizacion[campo] = datos[campo];
  });

  const negocio = await Business.findByIdAndUpdate(businessId, actualizacion, {
    new: true,
    runValidators: true,
  }).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

/**
 * Actualiza la configuración avanzada del negocio (settings).
 */
const actualizarSettings = async (businessId, { timezone, language, notifications }) => {
  const actualizacion = {};

  if (timezone !== undefined) actualizacion['settings.timezone'] = timezone;
  if (language !== undefined) actualizacion['settings.language'] = language;

  if (notifications !== undefined) {
    if (notifications.email !== undefined) {
      actualizacion['settings.notifications.email'] = notifications.email;
    }
    if (notifications.whatsapp !== undefined) {
      actualizacion['settings.notifications.whatsapp'] = notifications.whatsapp;
    }
  }

  const negocio = await Business.findByIdAndUpdate(businessId, { $set: actualizacion }, {
    new: true,
    runValidators: true,
  });

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio.settings;
};

module.exports = { obtenerNegocioActual, actualizarNegocio, actualizarSettings };
