const logger = require('../../../utils/logger');
const Lead = require('../../leads/lead.model');
// Módulo completo (no se destructura cambiarEtapa acá) — misma convención
// de "referencia viva" que el resto del repo (ver cloudinaryUtil en
// ai.service.js, gupshup.client.js, etc.).
const leadService = require('../../leads/lead.service');
const notificationService = require('../../admin/notification.service');
const pushService = require('../../push/push.service');
// CREA Product Intelligence™ V1.0, Etapa 6/10 — mismo criterio que
// leadService de arriba: se reusa product.service.js tal cual (Etapas 2/3,
// ya mergeadas), sin duplicar ninguna de sus reglas (aislamiento por
// tenant, resolución de moneda, invariantes de stock).
const productService = require('../../products/product.service');
// CREA SALES AI™ C.2 — Business Brain: Policies + FAQ V1, Etapa 6/11 —
// mismo criterio que productService de arriba: se reusa
// knowledgeRetrieval.service.js (Etapas 3/4, ya mergeadas) tal cual, sin
// duplicar sus hard filters de tenant/status/vigencia ni su lógica de
// precedencia/conflicto.
const knowledgeRetrievalService = require('../../business-knowledge/knowledgeRetrieval.service');

/**
 * Registro de tools reales que el modelo puede invocar durante
 * generateReply() (ver ai.service.js): escalate_to_human (PR33),
 * update_lead_stage (PR38), search_products/check_stock/get_price (CREA
 * Product Intelligence™ V1.0, Etapa 6/10), y search_business_knowledge
 * (CREA SALES AI™ C.2 — Business Brain: Policies + FAQ V1, Etapa 6/11).
 * El catálogo completo (Módulo 24/44 de docs/modules) queda para PRs
 * posteriores; este archivo está pensado para crecer agregando entradas a
 * TOOL_REGISTRY, no para reestructurarse.
 *
 * CREA SALES AI™ C.3 — Architecture & Agent Runtime V1, Etapa C3.2 (Tool
 * Registry formal, docs/architecture-runtime/CREA_SALES_AI_C3_..., §5.2):
 * hasta esta etapa, el schema que ve OpenAI (TOOL_SCHEMAS) y la función
 * que realmente corre (TOOL_EXECUTORS) vivían en 2 arrays/mapas paralelos,
 * mantenidos a mano en sincronía por convención, no por estructura.
 * TOOL_REGISTRY es ahora la ÚNICA fuente de verdad — un array de
 * ToolDefinition (name/description/inputSchema/authorization/execute) del
 * que TOOL_SCHEMAS y TOOL_EXECUTORS se DERIVAN más abajo. Es un refactor
 * de FORMA, no de comportamiento: mismos 6 nombres, mismas descripciones,
 * mismos parámetros, mismos executors, byte a byte — ver
 * index.formCompat.test.js para la verificación explícita de que
 * TOOL_SCHEMAS/TOOL_EXECUTORS derivados son idénticos a los que existían
 * antes de esta etapa.
 *
 * `authorization` es una función `(context) => boolean`, no un booleano
 * estático, para que en el futuro pueda depender de datos reales (plan del
 * negocio, rol del actor, etc.) sin cambiar la forma del registro otra
 * vez. V1 la deja en `() => true` para las 6 tools reales — es
 * exactamente el comportamiento de hoy (todas las tools ya están
 * disponibles siempre para cualquier conversación autenticada), declarado
 * ahora explícitamente en vez de estar implícito en que nunca hubo ningún
 * chequeo. Gating real por plan/negocio queda fuera de alcance de C3.2 —
 * no fue pedido y cambiaría comportamiento, no solo vocabulario.
 *
 * `timeout` (opcional en el ToolDefinition de la spec) se documenta como
 * "no aplicado en V1" a propósito — ningún executor actual tarda lo
 * suficiente como para justificar cortar su ejecución, y agregar un
 * mecanismo de timeout real (Promise.race, AbortController, etc.) sin una
 * necesidad demostrada sería exactamente el tipo de infraestructura que
 * la spec pide NO construir sin evidencia (§7).
 *
 * Nota de alcance sobre escalate_to_human: NO reutiliza
 * ai.controller.js#escalate() tal cual — ese es un handler de Express
 * (depende de req/res/next y de req.businessId para el scoping de
 * tenant), no una función invocable fuera de una request HTTP. Este
 * archivo replica la misma mutación real (status/escalatedAt/aiEnabled +
 * mensaje del sistema) sobre el documento de Conversation que
 * generateReply() ya tiene cargado en memoria — sin tocar
 * ai.controller.js, fuera del alcance de ese PR.
 *
 * update_lead_stage (PR38) es distinto: lead.service.js#cambiarEtapa() ya
 * es un service standalone (no atado a un controller de Express), así que
 * acá SÍ se reutiliza tal cual, sin duplicar nada — ver executor abajo.
 *
 * search_products/check_stock/get_price son el mismo caso que
 * update_lead_stage: product.service.js (Etapas 2/3) ya es standalone, se
 * reusa tal cual. El único dato de tenant que reciben es `context.business`
 * — el mismo objeto ya resuelto por generateReply() a partir del
 * canal/webhook (nunca de `args`, documento maestro §6/§25: "la IA nunca
 * debe elegir o inventar el tenant_id"). Las 3 comparten resolverProductId()
 * para el fallback a `conversation.activeProduct` (documento §21).
 */

/**
 * Ejecuta el escalamiento real sobre el documento de Conversation que ya
 * tiene cargado generateReply() — muta el objeto en memoria (status,
 * escalatedAt, aiEnabled, + mensaje de sistema) pero NO llama a
 * conversation.save(): ese guardado es responsabilidad exclusiva de
 * generateReply(), en un único save al final del loop, para evitar dos
 * escrituras independientes sobre el mismo documento (la del tool y la del
 * loop) pisándose entre sí.
 *
 * Idempotente a propósito: si la conversación ya estaba escalada (por este
 * mismo flujo, o porque un humano ya la escaló manualmente vía
 * ai.controller.js#escalate mientras tanto), no vuelve a mutar nada — le
 * avisa al modelo que ya estaba escalada para que pueda responder acorde,
 * en vez de lanzar un error que cortaría el loop de generateReply().
 */
const escalateToHuman = async (args, { conversation, lead }) => {
  const reason = typeof args?.reason === 'string' && args.reason.trim()
    ? args.reason.trim()
    : 'La IA determinó que la conversación requiere intervención humana.';

  if (conversation.status === 'escalated') {
    return { success: true, alreadyEscalated: true, message: 'La conversación ya estaba escalada a un agente humano.' };
  }

  conversation.status = 'escalated';
  conversation.escalatedAt = new Date();
  conversation.aiEnabled = false;
  conversation.messages.push({
    role: 'system',
    content: `Conversación escalada a humano por la IA. Motivo: ${reason}`,
    timestamp: new Date(),
  });

  // PR-D (roadmap de push/notificaciones) — Opción A: avisa solo al agente
  // asignado del lead (lead.assignedTo), mismo destinatario que los otros
  // 2 disparadores (lead_message/PR-C, update_lead_stage/PR-E), no a todos
  // los admins del negocio. Se omite si no hay nadie asignado.
  //
  // Va ACÁ (dentro del executor), no después en generateReply() tras el
  // save: escalateToHuman() no hace su propio conversation.save() (ver
  // nota de arriba — eso es responsabilidad exclusiva de generateReply(),
  // al final del loop), pero avisar al humano no depende de que ese save
  // ya haya ocurrido — la mutación real (status/aiEnabled/escalatedAt) ya
  // pasó en memoria acá arriba, y generateReply() la persiste de todos
  // modos.
  //
  // Cada canal en su propio try/catch, a propósito: un fallo acá NO debe
  // propagarse fuera de este executor — executeToolCall() envuelve toda
  // la ejecución y, si esta función tirara, le devolvería success:false al
  // modelo (ver tools/index.js#executeToolCall), haciéndole creer que el
  // escalamiento no funcionó cuando en realidad sí mutó la conversación
  // arriba. Mismo criterio fail-soft que el disparador de PR-C.
  if (lead?.assignedTo) {
    try {
      await notificationService.createNotification({
        business: conversation.business,
        user: lead.assignedTo,
        type: 'warning',
        category: 'lead',
        title: `${lead.name} pidió hablar con un humano`,
        message: reason,
        meta: { leadId: lead._id, conversationId: conversation._id, event: 'escalated_to_human' },
      });
    } catch (err) {
      logger.error(`escalateToHuman(): createNotification() falló (no afecta el escalamiento ya realizado): ${err.message}`);
    }

    try {
      await pushService.sendToUser(lead.assignedTo, {
        title: `${lead.name} pidió hablar con un humano`,
        body: reason,
        data: { type: 'escalated_to_human', leadId: String(lead._id), conversationId: String(conversation._id) },
      });
    } catch (err) {
      logger.error(`escalateToHuman(): sendToUser() falló (no afecta el escalamiento ya realizado): ${err.message}`);
    }
  }

  return { success: true, alreadyEscalated: false, message: 'Conversación escalada a un agente humano exitosamente.' };
};

/**
 * Actualiza conversation.lead a la etapa que pide el modelo, reutilizando
 * tal cual lead.service.js#cambiarEtapa() — sin duplicar su validación
 * (pipeline real del negocio, no un enum fijo) ni sus efectos secundarios
 * (activity log, triggerAutomations('lead_stage_changed', ...)).
 *
 * Idempotente por lectura fresca, a propósito: NO usa el `lead` que
 * generateReply() ya tiene en memoria (context.lead) — ese fue cargado al
 * INICIO del turno y puede haber quedado desactualizado si esta misma
 * tool ya corrió antes en el mismo loop (cambiarEtapa() muta y guarda su
 * propio documento recién consultado, no el objeto `lead` que se pasa acá
 * por contexto). Por eso se relee pipelineStage directo de Mongo antes de
 * decidir si hay algo que hacer.
 *
 * No lanza su propio try/catch: cualquier error de cambiarEtapa() (etapa
 * inválida para el pipeline de este negocio, lead no encontrado) lo
 * captura executeToolCall() de abajo, que ya envuelve toda ejecución de
 * executor — mismo criterio fail-soft que escalateToHuman(), sin
 * duplicar el manejo de errores acá.
 */
const updateLeadStage = async (args, { conversation }) => {
  const stage = typeof args?.stage === 'string' ? args.stage.trim() : '';
  if (!stage) {
    return { success: false, error: 'Falta el parámetro "stage" (obligatorio).' };
  }

  const leadActual = await Lead.findOne(
    { _id: conversation.lead, business: conversation.business, isDeleted: false },
    '_id pipelineStage'
  );
  if (!leadActual) {
    return { success: false, error: 'El lead asociado a esta conversación no existe o fue eliminado.' };
  }

  if (leadActual.pipelineStage === stage) {
    return { success: true, alreadyInStage: true, message: `El lead ya estaba en la etapa "${stage}".` };
  }

  const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
  // Actor sintético — no hay un User humano detrás de esta mutación.
  // performedBy queda sin setear (no es required en activitySchema);
  // performedByName sí se guarda, para que el activity log del lead
  // distinga a simple vista una acción de la IA de una de un humano.
  const actorIA = { _id: undefined, name: 'CREA (IA)' };

  const leadActualizado = await leadService.cambiarEtapa(conversation.business, conversation.lead, actorIA, stage, reason);

  // PR-E (roadmap de push/notificaciones) — disparador "lead_stage_changed":
  // avisa al agente asignado (mismo destinatario que PR-C/PR-D) de que la
  // IA movió al lead de etapa. Se omite si no hay nadie asignado. Usa
  // leadActualizado (el documento completo que ya devolvió cambiarEtapa(),
  // recién guardado, con assignedTo/name al día) — no hace falta otra
  // query a Mongo.
  //
  // Distinto de automation.engine.js#execSendNotification(): ese es un
  // canal opt-in que el negocio configura a mano (una regla de
  // automatización con trigger:'lead_stage_changed'); esto es un aviso
  // directo e incondicional, específico de que fue la IA quien decidió el
  // cambio — mismo criterio que los otros 2 disparadores de este roadmap.
  // cambiarEtapa() ya dispara triggerAutomations('lead_stage_changed', ...)
  // por su cuenta (ver lead.service.js) — son 2 caminos independientes que
  // conviven sin duplicarse.
  //
  // Fail-soft, mismo criterio que PR-C/PR-D: cada canal en su propio
  // try/catch — un fallo acá no debe convertir esta respuesta en
  // success:false (la etapa YA cambió y ya se guardó arriba).
  if (leadActualizado.assignedTo) {
    try {
      await notificationService.createNotification({
        business: conversation.business,
        user: leadActualizado.assignedTo,
        type: 'info',
        category: 'lead',
        title: `${leadActualizado.name} cambió de etapa`,
        message: reason ? `Ahora en "${stage}" — ${reason}` : `Ahora en "${stage}".`,
        meta: {
          leadId: leadActualizado._id,
          conversationId: conversation._id,
          event: 'lead_stage_changed',
          from: leadActual.pipelineStage,
          to: stage,
        },
      });
    } catch (err) {
      logger.error(`updateLeadStage(): createNotification() falló (no afecta el cambio de etapa ya guardado): ${err.message}`);
    }

    try {
      await pushService.sendToUser(leadActualizado.assignedTo, {
        title: `${leadActualizado.name} cambió de etapa`,
        body: `Ahora en "${stage}"`,
        data: { type: 'lead_stage_changed', leadId: String(leadActualizado._id), conversationId: String(conversation._id) },
      });
    } catch (err) {
      logger.error(`updateLeadStage(): sendToUser() falló (no afecta el cambio de etapa ya guardado): ${err.message}`);
    }
  }

  return {
    success: true,
    alreadyInStage: false,
    message: `Etapa del lead actualizada a "${stage}".`,
    pipelineStage: leadActualizado.pipelineStage,
  };
};

/**
 * Resuelve qué productId usar en check_stock/get_price: el que mandó el
 * modelo en `args` si vino, o si no, el de `conversation.activeProduct`
 * (documento maestro §21) — el que dejó el último search_products exitoso
 * de esta misma conversación. Devuelve '' si ninguno de los dos existe, para
 * que el caller decida el mensaje de error sin repetir esta lógica.
 */
const resolverProductId = (args, conversation) => {
  const productId = typeof args?.productId === 'string' ? args.productId.trim() : '';
  if (productId) return productId;
  return conversation.activeProduct?.productId ? conversation.activeProduct.productId.toString() : '';
};

/**
 * search_products() — documento maestro §13/§15. Reusa tal cual
 * product.service.js#buscarProductos() (Etapa 2), que ya resuelve el
 * aislamiento por tenant (`business._id`, nunca un id que venga de `args`),
 * el índice de texto en español, y el filtro `active:true`.
 *
 * Además de devolver los matches al modelo, actualiza
 * `conversation.activeProduct` EN MEMORIA (documento §21) — mismo criterio
 * fail-soft/no-save-propio que escalateToHuman/updateLeadStage: la
 * persistencia real la hace generateReply() en su único save() al final del
 * loop. Solo pisa el producto activo cuando HAY al menos un resultado — una
 * búsqueda sin resultados no debe borrar el contexto de un producto
 * identificado en un turno anterior (ej. el lead pregunta algo ambiguo a
 * mitad de la conversación sobre el MISMO producto ya encontrado antes).
 */
const searchProducts = async (args, { conversation, business }) => {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { success: false, error: 'Falta el parámetro "query" (obligatorio).' };
  }

  const matches = await productService.buscarProductos(business._id, query);

  if (matches.length > 0) {
    conversation.activeProduct = {
      productId: matches[0].productId,
      name: matches[0].name,
      lastSearchQuery: query,
      updatedAt: new Date(),
    };
  }

  return { success: true, matches };
};

/**
 * check_stock() — documento maestro §17/§22 (regla anti-alucinación). No
 * envuelve el error en su propio try/catch a propósito — mismo criterio que
 * updateLeadStage: si product.service.js#consultarStock() lanza (producto
 * no encontrado/desactivado, id malformado), lo captura executeToolCall()
 * de abajo, que ya devuelve `{success:false, error:...}` sin propagar —
 * suficiente para que el modelo "indique de forma natural" el fallo en vez
 * de inventar un stock, sin duplicar el manejo de errores acá.
 */
const checkStock = async (args, { conversation, business }) => {
  const productId = resolverProductId(args, conversation);
  if (!productId) {
    return { success: false, error: 'Falta el productId y no hay ningún producto identificado antes en esta conversación. Usa search_products primero.' };
  }

  const stock = await productService.consultarStock(business._id, productId);
  return { success: true, ...stock };
};

/**
 * get_price() — documento maestro §18/§22. Mismo criterio que checkStock:
 * sin try/catch propio, `priceAvailable:false` (del service) es la señal de
 * "no inventes un precio", y cualquier error real lo maneja
 * executeToolCall().
 */
const getPrice = async (args, { conversation, business }) => {
  const productId = resolverProductId(args, conversation);
  if (!productId) {
    return { success: false, error: 'Falta el productId y no hay ningún producto identificado antes en esta conversación. Usa search_products primero.' };
  }

  const precio = await productService.consultarPrecio(business._id, productId);
  return { success: true, ...precio };
};

/**
 * search_business_knowledge() — CREA SALES AI™ C.2, Etapa 6/11. Mismo
 * criterio de resolución de producto que resolverProductId() de arriba
 * (documento §21 — se reusa `conversation.activeProduct` TAL CUAL, sin
 * agregar un campo de memoria nuevo): si el modelo no manda `productIds`,
 * se usa el último producto identificado en esta conversación, si hay uno.
 *
 * `channelId` sale de `conversation.whatsappChannel` — nunca del modelo:
 * es un dato de contexto real de POR QUÉ CANAL entró este mensaje (PR-10a,
 * ver conversation.model.js), no algo que el lead pueda expresar en un
 * mensaje, mismo principio que `business._id` (documento §13: "el
 * tenantId no debe ser elegido libremente por el LLM").
 *
 * El resultado de resolverConocimiento() (Etapas 3/4) se recorta antes de
 * devolverlo al modelo — mismo criterio que buscarProductos() en
 * product.service.js: nunca exponer campos internos (business, _id,
 * timestamps, source, version) que no aportan nada a la respuesta y solo
 * suman tokens. `code`/`category` sí viajan — le sirven al modelo como
 * referencia interna si necesita citar la política por su identificador
 * ante una repregunta del lead.
 */
const searchBusinessKnowledge = async (args, { conversation, business }) => {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { success: false, error: 'Falta el parámetro "query" (obligatorio).' };
  }

  const productIds = Array.isArray(args?.productIds) && args.productIds.length
    ? args.productIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : (conversation.activeProduct?.productId ? [conversation.activeProduct.productId.toString()] : []);

  const channelId = conversation.whatsappChannel ? conversation.whatsappChannel.toString() : undefined;

  const resultado = await knowledgeRetrievalService.resolverConocimiento(business._id, query, { productIds, channelId });

  return {
    success: true,
    policies: resultado.policies.map((p) => ({
      code: p.code,
      category: p.category,
      statement: p.statement,
      customerFacingText: p.customerFacingText,
      responseMode: p.action?.responseMode,
      handoffReason: p.action?.handoffReason,
    })),
    faqs: resultado.faqs.map((f) => ({
      question: f.question,
      answer: f.answer,
      category: f.category,
    })),
    conflictDetected: resultado.conflictDetected,
    needsClarification: resultado.needsClarification,
  };
};

// Autorización V1 — ver el comentario largo de arriba: siempre `true`
// para las 6 tools reales, declarado explícitamente en vez de implícito.
// Una única función compartida (no una por tool) porque hoy el criterio
// es IDÉNTICO para las 6 — el día que deje de serlo, cada entrada puede
// pasar a tener la suya propia sin tocar el resto del registro.
const siempreAutorizada = () => true;

/**
 * TOOL_REGISTRY — C.3, Etapa C3.2. Única fuente de verdad de las tools
 * reales (ver el comentario largo al inicio del archivo). `inputSchema` es
 * el mismo JSON Schema que antes vivía embebido en cada entrada de
 * TOOL_SCHEMAS (`function.parameters`) — nombre distinto acá porque
 * `parameters` es terminología de la API de OpenAI, mientras que
 * `inputSchema` es el nombre que usa el ToolDefinition de la spec de C.3.
 */
const TOOL_REGISTRY = [
  {
    name: 'escalate_to_human',
    description:
      'Escala esta conversación a un agente humano y desactiva las respuestas automáticas de la IA. ' +
      'Úsala cuando el lead pide explícitamente hablar con una persona, muestra frustración fuerte con ' +
      'la IA, o la situación excede lo que puedes resolver como agente de ventas conversacional ' +
      '(reclamos, disputas de pago, algo fuera de tu alcance). No la uses solo porque el lead hizo ' +
      'una pregunta difícil que sí puedes intentar responder.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Motivo breve y concreto del escalamiento, en español, para que el agente humano tenga contexto inmediato.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: escalateToHuman,
  },
  {
    name: 'update_lead_stage',
    description:
      'Actualiza la etapa del lead en el pipeline de ventas del negocio. Úsala cuando la conversación deja ' +
      'claro que el lead avanzó a una etapa distinta del proceso comercial (ej. pasó de "interesado" a pedir ' +
      'una propuesta formal, a negociar condiciones, o decidió no continuar). Etapas típicas: new, contacted, ' +
      'interested, proposal, negotiation, won, lost — pero cada negocio puede tener las suyas propias; si usas ' +
      'una etapa que no existe para este negocio, el sistema te devuelve la lista de etapas válidas para que ' +
      'reintentes con la correcta. No la uses solo porque el lead hizo una pregunta — solo ante una señal real ' +
      'de cambio de etapa.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Clave (key) de la etapa destino. Usa la que corresponda al pipeline real de este negocio si la conoces por el contexto; si no, usa una etapa típica (new, contacted, interested, proposal, negotiation, won, lost).',
        },
        reason: {
          type: 'string',
          description: 'Motivo breve del cambio de etapa, para el registro de actividad del lead. Opcional — no lo inventes si el lead simplemente avanzó de forma natural en la conversación.',
        },
      },
      required: ['stage'],
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: updateLeadStage,
  },
  {
    name: 'search_products',
    description:
      'Busca productos del catálogo REAL de este negocio por nombre, marca, categoría o palabras clave. Úsala ' +
      'SIEMPRE que el lead pregunte si tienen un producto, pida presentaciones/variantes, o mencione algo que ' +
      'podría ser un producto del catálogo (ej. "¿tienen moringa?", "¿tienen aceite de coco?") — nunca afirmes ' +
      'ni descartes la existencia de un producto sin llamar a esta tool primero. Devuelve como máximo 5 ' +
      'coincidencias con su productId — usalo después en check_stock/get_price para confirmar disponibilidad o ' +
      'precio real antes de responder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Términos de búsqueda, en las palabras reales que usó el lead (ej. "pastillas de moringa"). No ' +
            'inventes ni completes el nombre de un producto que el lead no mencionó.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: searchProducts,
  },
  {
    name: 'check_stock',
    description:
      'Consulta el stock REAL y disponible de un producto de este negocio. Úsala SIEMPRE antes de decirle al ' +
      'lead que un producto tiene o no tiene stock — nunca asumas ni inventes disponibilidad. Si la tool falla ' +
      'o no encuentra el producto, decilo de forma natural (ej. "no puedo confirmar el stock ahora mismo") en ' +
      'vez de afirmar un número. Si no tenés el productId a mano, podés omitirlo cuando el lead se refiere al ' +
      'producto del que ya se venía hablando en esta conversación.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description:
            'ID del producto (de un resultado previo de search_products en esta misma conversación). Opcional ' +
            'si ya hay un producto identificado antes en la conversación.',
        },
      },
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: checkStock,
  },
  {
    name: 'get_price',
    description:
      'Consulta el precio REAL de un producto de este negocio. Úsala SIEMPRE antes de mencionar o confirmar un ' +
      'precio — nunca inventes, estimes ni redondees un precio que no te devolvió esta tool. Si la tool falla, ' +
      'no encuentra el producto, o el producto no tiene precio cargado, decilo de forma natural (ej. "dejame ' +
      'confirmar el precio y te aviso") en vez de afirmar un número. Si no tenés el productId a mano, podés ' +
      'omitirlo cuando el lead se refiere al producto del que ya se venía hablando en esta conversación.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description:
            'ID del producto (de un resultado previo de search_products en esta misma conversación). Opcional ' +
            'si ya hay un producto identificado antes en la conversación.',
        },
      },
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: getPrice,
  },
  {
    name: 'search_business_knowledge',
    description:
      'Busca políticas (garantías, cambios, devoluciones, pagos, reservas, cancelaciones, etc.) y preguntas ' +
      'frecuentes AUTORIZADAS de este negocio. Úsala SIEMPRE que el lead pregunte por una regla, condición, ' +
      'plazo, requisito, o algo que podría estar cubierto por una política o FAQ del negocio — nunca respondas ' +
      'ese tipo de pregunta de memoria ni inventando una regla que esta herramienta no confirmó.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Términos de búsqueda, en las palabras reales que usó el lead (ej. "cuántos días tengo para devolver").',
        },
        productIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'IDs de producto (de un resultado previo de search_products) si la pregunta es específica de un producto puntual. ' +
            'Opcional — si ya hay un producto identificado antes en esta conversación, podés omitirlo.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    authorization: siempreAutorizada,
    execute: searchBusinessKnowledge,
  },
];

// Derivados de TOOL_REGISTRY — nunca mantenidos a mano en paralelo.
// TOOL_SCHEMAS conserva el shape EXACTO que espera `tools:` en la API de
// OpenAI (ai.service.js#generateReply()); TOOL_EXECUTORS se mantiene
// exportado por compatibilidad con cualquier código que ya lo importara.
const TOOL_SCHEMAS = TOOL_REGISTRY.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}));

const TOOL_EXECUTORS = Object.fromEntries(TOOL_REGISTRY.map((tool) => [tool.name, tool.execute]));

/**
 * Punto de entrada único que usa generateReply() para correr una tool call
 * que pidió el modelo. Nunca lanza — cualquier error (JSON de argumentos
 * inválido, tool desconocida, no autorizada, excepción del executor) se
 * devuelve como resultado con success:false en vez de propagarse, para que
 * el loop de generateReply() pueda seguir y el modelo tenga la chance de
 * responderle al lead igual (fail-soft, mismo criterio que
 * saveInboundMessage() con la media entrante).
 *
 * CREA SALES AI™ C.3, Etapa C3.2: ahora resuelve contra TOOL_REGISTRY (no
 * contra TOOL_EXECUTORS directo) para poder chequear `tool.authorization`
 * ANTES de ejecutar — "el modelo puede solicitar una tool; el runtime
 * decide si está autorizada" (spec §5.2), en código, nunca por obediencia
 * del modelo (regla no-negociable #3). V1: authorization siempre `true`
 * para las 6 tools reales, así que este chequeo nunca bloquea nada hoy —
 * el comportamiento observable es idéntico al de antes de esta etapa.
 *
 * @param {object} toolCall - tal cual lo devuelve OpenAI (choices[0].message.tool_calls[i])
 * @param {{ conversation: import('../conversation.model'), business: object, lead: object }} context
 * @returns {Promise<object>} resultado serializable, nunca undefined
 */
const executeToolCall = async (toolCall, context) => {
  const name = toolCall?.function?.name;
  const tool = TOOL_REGISTRY.find((t) => t.name === name);

  if (!tool) {
    logger.error(`generateReply(): el modelo pidió una tool desconocida: ${name}`);
    return { success: false, error: `Tool desconocida: ${name}` };
  }

  if (!tool.authorization(context)) {
    logger.warn(`generateReply(): tool "${name}" no autorizada para este contexto`);
    return { success: false, error: `Tool no autorizada: ${name}` };
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch (error) {
    logger.error(`generateReply(): argumentos de tool call inválidos para ${name}: ${error.message}`);
    return { success: false, error: 'Argumentos de la tool inválidos (JSON malformado).' };
  }

  try {
    return await tool.execute(args, context);
  } catch (error) {
    logger.error(`generateReply(): error ejecutando tool ${name}: ${error.message}`);
    return { success: false, error: `Error ejecutando ${name}: ${error.message}` };
  }
};

module.exports = { TOOL_REGISTRY, TOOL_SCHEMAS, TOOL_EXECUTORS, executeToolCall };
