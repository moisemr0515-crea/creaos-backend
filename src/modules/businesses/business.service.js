const OpenAI = require('openai');
const { PDFParse } = require('pdf-parse');
const Business = require('./business.model');
const { AppError } = require('../../middleware/error.middleware');
const { subirBuffer, eliminarPorUrl } = require('../../utils/cloudinary');
const logger = require('../../utils/logger');
const { OPENAI_API_KEY, OPENAI_MODEL } = require('../../config/env');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const MAX_PDF_TEXT_LENGTH = 5000;
const MAX_PDF_SUMMARY_LENGTH = 800;

// Auditoría de contexto del agente (12/sep/2026): un PDF escaneado/de
// imágenes (pdf-parse no hace OCR) devuelve texto vacío o casi vacío.
// Mandar eso igual a OpenAI para "resumir" produce una disculpa del modelo
// ("no puedo resumir, no me diste texto") que antes se guardaba tal cual en
// pdfSummary — confirmado en producción para el negocio CREA OS, cuyo
// pdfSummary real era exactamente esa disculpa, inyectada en cada
// conversación de venta como si fuera información legítima del negocio
// (buildSystemPrompt() no tiene forma de distinguir un resumen real de uno
// degenerado). Umbral arbitrario pero conservador: cualquier documento con
// contenido real de negocio (qué vende, precios, políticas) supera esto de
// sobra; un PDF vacío/casi vacío nunca lo alcanza.
const MIN_PDF_TEXT_LENGTH = 50;

/**
 * Resume el texto del PDF a lo esencial para un agente de ventas
 * (se genera una sola vez al subir el PDF, no en cada mensaje de la IA).
 * Si falla (rate limit, error de API, etc.), cae a un truncado simple
 * del texto original para no bloquear la subida del archivo.
 */
const generarResumenPdf = async (textoCompleto) => {
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Resume el siguiente documento de un negocio en máximo 4 oraciones, ' +
            'enfocándote en qué vende, sus diferenciadores, y datos útiles para ' +
            'que un agente de ventas por WhatsApp lo use en conversaciones con leads ' +
            '(precios, garantías, políticas, etc). No inventes información que no esté en el texto.',
        },
        { role: 'user', content: textoCompleto },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    return completion.choices[0].message.content.slice(0, MAX_PDF_SUMMARY_LENGTH);
  } catch (error) {
    logger.warn(`No se pudo generar el resumen del PDF con IA, se usa truncado simple: ${error.message}`);
    return textoCompleto.slice(0, MAX_PDF_SUMMARY_LENGTH);
  }
};

/**
 * Obtiene el negocio actual del usuario autenticado.
 */
const obtenerNegocioActual = async (businessId) => {
  const negocio = await Business.findById(businessId).populate('createdBy', 'name email');

  if (!negocio) throw new AppError('Negocio no encontrado', 404);

  return negocio;
};

// Campos del wizard de onboarding — cuando los 4 quedan llenos, se marca onboardingCompleted
const CAMPOS_ONBOARDING = ['productDescription', 'averageTicket', 'targetCustomer', 'whatsappNumber'];

/**
 * Actualiza datos principales del negocio (nombre, logo, industria, etc.).
 */
const actualizarNegocio = async (businessId, datos) => {
  // facebookUrl/instagramUrl/tiktokUrl (12/sep/2026): agregados al lado de
  // `website` — mismo endpoint, sin cambios estructurales. Sin este
  // allowlist, un campo nuevo se descarta en silencio aunque exista en el
  // schema (mismo patrón de bug ya visto esta sesión con aiPersonality
  // antes de su propio fix — ver comentario de ese campo en el schema).
  const camposPermitidos = ['name', 'logo', 'industry', 'country', 'currency', 'phone', 'email', 'website', 'facebookUrl', 'instagramUrl', 'tiktokUrl', 'whatsappNumber', 'productDescription', 'averageTicket', 'targetCustomer', 'aiInstructions', 'aiPersonality', 'aiSalesEnabled'];
  const actualizacion = {};

  camposPermitidos.forEach((campo) => {
    if (datos[campo] !== undefined) actualizacion[campo] = datos[campo];
  });

  const negocioActual = await Business.findById(businessId).select(`onboardingCompleted ${CAMPOS_ONBOARDING.join(' ')}`);
  if (!negocioActual) throw new AppError('Negocio no encontrado', 404);

  if (!negocioActual.onboardingCompleted) {
    const quedanTodosLosCamposLlenos = CAMPOS_ONBOARDING.every((campo) => {
      const valor = actualizacion[campo] !== undefined ? actualizacion[campo] : negocioActual[campo];
      return valor !== null && valor !== undefined && valor !== '';
    });
    if (quedanTodosLosCamposLlenos) actualizacion.onboardingCompleted = true;
  }

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
  const negocioAnterior = await Business.findById(businessId);
  if (!negocioAnterior) throw new AppError('Negocio no encontrado', 404);

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

  // Borrado best-effort del logo anterior — no debe bloquear la respuesta
  await eliminarPorUrl(negocioAnterior.logo, logger);

  return negocio;
};

/**
 * Sube hasta 2 fotos de producto a Cloudinary (reemplaza las anteriores).
 */
const subirFotos = async (businessId, files) => {
  if (files.length > 2) throw new AppError('Máximo 2 fotos de producto', 400);

  const negocioAnterior = await Business.findById(businessId);
  if (!negocioAnterior) throw new AppError('Negocio no encontrado', 404);

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

  // Borrado best-effort de las fotos anteriores — no debe bloquear la respuesta
  await Promise.all(negocioAnterior.photos.map((url) => eliminarPorUrl(url, logger)));

  return negocio;
};

/**
 * Sube el PDF informativo a Cloudinary y extrae su texto
 * (truncado) para usarlo en el prompt de la IA de ventas.
 */
const subirPdf = async (businessId, file) => {
  const negocioAnterior = await Business.findById(businessId);
  if (!negocioAnterior) throw new AppError('Negocio no encontrado', 404);

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

  // pdf-parse inserta separadores de página ("-- 1 of 3 --") que no aportan
  // nada al prompt de la IA y solo restan espacio útil del texto truncado
  const textoLimpio = texto
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Guard (auditoría de contexto del agente, 12/sep/2026): si la extracción
  // no trajo contenido real (PDF escaneado/de imágenes, pdf-parse no hace
  // OCR), no tiene sentido pagar una llamada a OpenAI para "resumir" texto
  // vacío — y la respuesta que devolvería (una disculpa del modelo) NUNCA
  // debe guardarse como si fuera información real del negocio. Se sube el
  // PDF igual (pdfUrl/pdfUploadedAt) para que el dueño vea que se subió,
  // pero pdfExtractedText/pdfSummary quedan en null — buildSystemPrompt()
  // ya trata ambos como "sin información adicional" cuando son falsy
  // (mismo filter(Boolean) de siempre), así que no se inyecta nada roto.
  const extraccionExitosa = textoLimpio.length >= MIN_PDF_TEXT_LENGTH;
  if (!extraccionExitosa) {
    logger.warn(
      `[subirPdf] PDF de business ${businessId} extrajo muy poco texto (${textoLimpio.length} caracteres, mínimo ${MIN_PDF_TEXT_LENGTH}) — probablemente escaneado/de imágenes. Se guarda el archivo pero NO se genera pdfSummary (evita inyectar una disculpa del modelo como si fuera información real).`
    );
  }

  const resumen = extraccionExitosa ? await generarResumenPdf(textoLimpio) : null;

  const negocio = await Business.findByIdAndUpdate(
    businessId,
    {
      pdfUrl: resultado.secure_url,
      pdfExtractedText: extraccionExitosa ? textoLimpio.slice(0, MAX_PDF_TEXT_LENGTH) : null,
      pdfSummary: resumen,
      pdfUploadedAt: new Date(),
    },
    { new: true, runValidators: true }
  ).populate('createdBy', 'name email');

  // Borrado best-effort del PDF anterior — no debe bloquear la respuesta
  await eliminarPorUrl(negocioAnterior.pdfUrl, logger);

  return negocio;
};

module.exports = {
  obtenerNegocioActual,
  actualizarNegocio,
  actualizarSettings,
  subirLogo,
  subirFotos,
  subirPdf,
  openai, // exportado para poder mockear/espiar en tests, mismo criterio que ai.service.js
};
