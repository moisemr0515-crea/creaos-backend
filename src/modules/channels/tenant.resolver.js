const { AppError } = require('../../middleware/error.middleware');
const Business = require('../businesses/business.model');

/**
 * TenantResolver — aislamiento estructural, no alias (Decisión 1 del
 * Implementation Blueprint, §4.4). No es un simple `return channel.tenantId`:
 * valida activamente contra Business en cada llamada, mismo chequeo que ya
 * hace tenant.middleware.js#injectTenant en la capa HTTP.
 *
 * Esto es lo que originó el bug del Caso 8: un businessId fijo, nunca
 * re-verificado. TenantResolver rechaza explícitamente un tenantId huérfano
 * en vez de dejarlo pasar por transitividad de un valor copiado.
 */

/**
 * @param {{tenantId: string}} channel
 * @returns {Promise<string>} tenantId validado
 * @throws {AppError} si el negocio no existe o está inactivo
 */
async function resolve(channel) {
  const business = await Business.findOne({ _id: channel.tenantId, isActive: true }).select('_id');

  if (!business) {
    throw new AppError(`Tenant ${channel.tenantId} no encontrado o inactivo`, 403);
  }

  return business._id;
}

/**
 * Guard usado en cada hand-off entre capas del pipeline de canal (antes de
 * persistir InboundEvent, antes de encolar, antes de que el Worker procese,
 * antes de llamar al AgentRuntime — sub-fases 1.c/1.d). Protección adicional
 * contra que un bug futuro sustituya silenciosamente el tenant en algún
 * paso intermedio.
 *
 * @throws {AppError} si expectedTenantId !== documentTenantId
 */
function assertTenantScope(expectedTenantId, documentTenantId) {
  if (String(expectedTenantId) !== String(documentTenantId)) {
    throw new AppError('Tenant scope mismatch — posible bug de aislamiento entre pasos del pipeline', 500);
  }
}

module.exports = { resolve, assertTenantScope };
