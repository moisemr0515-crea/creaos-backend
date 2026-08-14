const WhatsAppConnection = require('./whatsappConnection.model');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');
const logger = require('../../utils/logger');
const { estaConfigurado } = require('../webhooks/gupshup.client');
const { GUPSHUP_PHONE_NUMBER } = require('../../config/env');

// Formato E.164 básico: "+" seguido de 8 a 15 dígitos (ej. +51910265404)
const PHONE_REGEX = /^\+[1-9]\d{7,14}$/;

// ─── POST /api/v1/whatsapp/connections ───────────────────────────────────────

const createConnection = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber || !PHONE_REGEX.test(phoneNumber)) {
      throw new AppError('phoneNumber inválido. Usa formato internacional, ej. +51910265404', 400);
    }

    // TODO v1.2: aquí va la llamada real a la API de partner de Gupshup
    // (Meta Embedded Signup + Gupshup ISV/Partner, ticket #264467) una vez
    // aprobado el acceso — registrar el número en Meta, obtener el wabaId real,
    // y solo marcar 'connected' cuando la verificación real sea exitosa.
    // Por ahora es 100% simulado: no se contacta a Meta ni a Gupshup.
    const connection = await WhatsAppConnection.create({
      business: req.businessId,
      phoneNumber,
      wabaId: null,
      status: 'connected',
      connectedAt: new Date(),
      isSimulated: true,
    });

    logger.info('[whatsapp] Conexión simulada creada', {
      businessId: req.businessId.toString(),
      userId: req.user?._id?.toString(),
      connectionId: connection._id.toString(),
      phoneNumber,
    });

    return respuestaExito(res, {
      statusCode: 201,
      message: 'Conexión de WhatsApp creada (simulada)',
      data: { connection },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/whatsapp/connections ────────────────────────────────────────

const listConnections = async (req, res, next) => {
  try {
    const connections = await WhatsAppConnection.find({ business: req.businessId }).sort({ createdAt: -1 });

    return respuestaExito(res, {
      message: 'Conexiones de WhatsApp obtenidas',
      data: { connections },
    });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/v1/whatsapp/connections/:id ─────────────────────────────────

const disconnectConnection = async (req, res, next) => {
  try {
    const connection = await WhatsAppConnection.findOneAndUpdate(
      { _id: req.params.id, business: req.businessId },
      { $set: { status: 'disconnected' } },
      { new: true }
    );

    if (!connection) throw new AppError('Conexión no encontrada', 404);

    logger.info('[whatsapp] Conexión desconectada', {
      businessId: req.businessId.toString(),
      userId: req.user?._id?.toString(),
      connectionId: connection._id.toString(),
    });

    return respuestaExito(res, {
      message: 'Conexión de WhatsApp desconectada',
      data: { connection },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/whatsapp/status ──────────────────────────────────────────────
// Fix 2 del Caso 8: fuente de verdad real del canal de WhatsApp, basada en las
// env vars de Gupshup — a propósito NO usa WhatsAppConnection (ese modelo es
// un placeholder simulado del feature futuro de número dedicado por negocio,
// ver whatsappConnection.model.js). Único canal compartido por ahora, así que
// no depende de req.businessId — es el mismo resultado para cualquier negocio
// hasta que exista v1.2 (multi-número).

const getStatus = async (req, res, next) => {
  try {
    const connected = estaConfigurado();

    return respuestaExito(res, {
      message: 'Estado del canal de WhatsApp obtenido',
      data: {
        connected,
        provider: 'gupshup',
        phoneNumber: connected ? GUPSHUP_PHONE_NUMBER : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { createConnection, listConnections, disconnectConnection, getStatus };
