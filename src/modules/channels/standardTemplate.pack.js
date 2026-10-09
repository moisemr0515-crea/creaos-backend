const STANDARD_TEMPLATE_PACK = Object.freeze([
  {
    name: 'seguimiento_comercial',
    displayName: 'Seguimiento comercial',
    language: 'es',
    category: 'MARKETING',
    body: 'Hola {{1}}, soy {{2}} de {{3}}. Hace poco conversamos sobre nuestros servicios. ¿Deseas que continuemos por aquí para ayudarte con la información que quedó pendiente?',
    example: 'Hola Ana, soy Carlos de Mi Negocio. Hace poco conversamos sobre nuestros servicios. ¿Deseas que continuemos por aquí para ayudarte con la información que quedó pendiente?',
  },
  {
    name: 'seguimiento_cotizacion',
    displayName: 'Seguimiento de cotización',
    language: 'es',
    category: 'UTILITY',
    body: 'Hola {{1}}, te contactamos de {{2}} respecto a la cotización que solicitaste. Si deseas, podemos continuar por aquí para revisar los detalles o resolver alguna consulta pendiente.',
    example: 'Hola Ana, te contactamos de Mi Negocio respecto a la cotización que solicitaste. Si deseas, podemos continuar por aquí para revisar los detalles o resolver alguna consulta pendiente.',
  },
  {
    name: 'reactivar_prospecto',
    displayName: 'Reactivar prospecto',
    language: 'es',
    category: 'MARKETING',
    body: 'Hola {{1}}, soy {{2}} de {{3}}. Queríamos saber si todavía estás interesado en la información que conversamos anteriormente. Si deseas continuar, podemos atenderte por este medio.',
    example: 'Hola Ana, soy Carlos de Mi Negocio. Queríamos saber si todavía estás interesado en la información que conversamos anteriormente. Si deseas continuar, podemos atenderte por este medio.',
  },
  {
    name: 'recordatorio_cita',
    displayName: 'Recordatorio de cita',
    language: 'es',
    category: 'UTILITY',
    body: 'Hola {{1}}, te recordamos tu cita con {{2}} programada para {{3}}. Si necesitas confirmar o realizar algún cambio, puedes responder a este mensaje.',
    example: 'Hola Ana, te recordamos tu cita con Carlos programada para el 15 de octubre a las 10:00. Si necesitas confirmar o realizar algún cambio, puedes responder a este mensaje.',
  },
  {
    name: 'primer_contacto_comercial',
    displayName: 'Primer contacto comercial',
    language: 'es',
    category: 'MARKETING',
    body: 'Hola {{1}}, soy {{2}} de {{3}}. Nos compartiste tus datos para recibir información sobre nuestros productos o servicios. ¿Deseas que continuemos por este medio?',
    example: 'Hola Ana, soy Carlos de Mi Negocio. Nos compartiste tus datos para recibir información sobre nuestros productos o servicios. ¿Deseas que continuemos por este medio?',
  },
]);

module.exports = { STANDARD_TEMPLATE_PACK };