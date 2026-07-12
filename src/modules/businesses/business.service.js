const { PDFParse } = require('pdf-parse');
const Business = require('./business.model');
const { AppError } = require('../../middleware/error.middleware');
const { subirBuffer } = require('../../utils/cloudinary');

const MAX_PDF_TEXT_LENGTH = 5000;

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

/**
 * Sube el logo del negocio a Cloudinary y actualiza el negocio.
 */
const subirLogo = async (businessId, file) => {
  const resultado = await subirBuffer(file.buffer, {
    folder: `creaos/businesses/${businessId}/logo`,
    resource_type: 'image',
    overwrite: true,
  });

  const negocio = await Business.findByIdAndUpdate(
    businessId,
    { logo: resultado.secure_url },
    { new: true, runValidators: true }
  ).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

/**
 * Sube hasta 2 fotos de producto a Cloudinary (reemplaza las anteriores).
 */
const subirFotos = async (businessId, files) => {
  if (files.length > 2) throw new AppError('Máximo 2 fotos de producto', 400);

  const urls = await Promise.all(
    files.map((file) =>
      subirBuffer(file.buffer, {
        folder: `creaos/businesses/${businessId}/photos`,
        resource_type: 'image',
      }).then((resultado) => resultado.secure_url)
    )
  );

  const negocio = await Business.findByIdAndUpdate(
    businessId,
    { photos: urls },
    { new: true, runValidators: true }
  ).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

/**
 * Sube el PDF informativo a Cloudinary y extrae su texto
 * (truncado) para usarlo en el prompt de la IA de ventas.
 */
const subirPdf = async (businessId, file) => {
  const resultado = await subirBuffer(file.buffer, {
    folder: `creaos/businesses/${businessId}/pdf`,
    resource_type: 'raw',
    format: 'pdf',
    overwrite: true,
  });

  let texto;
  const parser = new PDFParse({ data: file.buffer });
  try {
    const resultadoTexto = await parser.getText();
    texto = resultadoTexto.text || '';
  } catch (err) {
    throw new AppError('No se pudo extraer el texto del PDF. Verifica que el archivo no esté corrupto o protegido.', 422);
  } finally {
    await parser.destroy();
  }

  const negocio = await Business.findByIdAndUpdate(
    businessId,
    {
      pdfUrl: resultado.secure_url,
      pdfExtractedText: texto.slice(0, MAX_PDF_TEXT_LENGTH),
      pdfUploadedAt: new Date(),
    },
    { new: true, runValidators: true }
  ).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

module.exports = {
  obtenerNegocioActual,
  actualizarNegocio,
  actualizarSettings,
  subirLogo,
  subirFotos,
  subirPdf,
};
