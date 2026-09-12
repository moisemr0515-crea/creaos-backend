# C.3 — Architecture & Agent Runtime V1: Auditoría de estado actual

**Fecha:** 12/sep/2026
**Alcance:** Solo lectura. Ningún archivo de código fue modificado para producir este documento.
**Metodología:** lectura completa de `docs/architecture-runtime/CREA_SALES_AI_C3_Architecture_Runtime_V1_Implementation_Spec.md`; lectura de M43–M50 de `docs/modules/` (delegada a un sub-agente de exploración, con foco en detalle técnico concreto vs. narrativa); auditoría directa del backend real (`creaos-backend`) archivo por archivo, siguiendo los 11 puntos de localización pedidos. No se auditó frontend — ningún componente de C.3 (runtime/orchestrator/tool registry/trace) tiene superficie de UI; el único punto de contacto con frontend es indirecto (RBAC ya auditado en C.2).

---

## 0. Hallazgo central — LA HIPÓTESIS DEL USUARIO SE CONFIRMA, CON MATICES IMPORTANTES

**La hipótesis es correcta en su núcleo, pero incompleta**: no existe un solo orquestador de facto — existen **dos caminos paralelos**, y el que corre en producción HOY **no es** el que ya tiene forma de runtime formal.

Concretamente:

1. **Existe un contrato de runtime YA ESCRITO** (`IAgentRuntime` + `DefaultAgentRuntime`, `src/modules/channels/agentRuntime.interface.js` + `defaultAgentRuntime.js`) que envuelve `ai.service.js#generateReply()` exactamente con la forma que pide la spec §5.1 (`process(input) → output`, sin lógica nueva, pensado explícitamente — por su propio comentario — para que un futuro "Bloque C" lo reemplace sin tocar Worker/Gateway/Channel).
2. **Pero ese contrato NO es el camino que corre en producción hoy.** El camino real y activo (`webhook.controller.js#gupshupWebhook()` → `inbound.gateway.js#handle()` con `WHATSAPP_QUEUE_PROCESSING_ENABLED=false` → `webhook.service.js#processGupshupMessage()`) llama a `aiService.generateReply()` **directamente**, sin pasar por `DefaultAgentRuntime`. El único consumidor real de `DefaultAgentRuntime` es `inbound.worker.js#processInboundJob()`, que solo se ejecuta si ese flag está en `true` — y un comentario propio del código (`inbound.worker.js:174`) confirma explícitamente: *"Este camino no está activo en producción todavía (WHATSAPP_QUEUE_PROCESSING_ENABLED=false)"*.
3. **`generateReply()` en sí ya opera, de facto, como el orquestador que pide la spec §5.3**: construye contexto mínimo (`buildSystemPrompt`), expone tools autorizadas (`TOOL_SCHEMAS`), ejecuta el ciclo del agente (loop `for` con `MAX_TOOL_ITERATIONS=5`), controla el máximo de tool calls, y compone el resultado final. Lo único que **no** hace es exponerlo con el vocabulario de la spec (`outcome`, `toolsUsed`, `knowledgeSources`, `correlationId`) ni degradar el límite de iteraciones a un outcome — hoy lanza una excepción.
4. **`ai/tools/index.js` ya es, de facto, un Tool Registry**: `TOOL_SCHEMAS` (array declarativo) + `TOOL_EXECUTORS` (mapa nombre→función) + `executeToolCall()` (punto único de entrada, nunca lanza, ya hace "el modelo pide, el runtime decide" — length del registro decide si la tool existe, no la obediencia del modelo). Le falta el vocabulario formal de `ToolDefinition` (`authorization`, `timeout`) pero el comportamiento de autorización-en-código y fail-soft ya existe.

**Conclusión práctica para el plan de PRs:** C.3 V1 se reduce, en gran medida, a (a) formalizar el vocabulario/contrato sobre lo que ya opera (`generateReply()`), (b) decidir qué hacer con el camino paralelo que ya existe pero está apagado (`DefaultAgentRuntime`/Worker), y (c) cerrar 2-3 gaps concretos y reales que esta auditoría encontró en ese camino apagado (ver §3). No hace falta construir un runtime desde cero.

---

## 1. Localización de los 11 componentes pedidos

| # | Componente | Archivo:función real |
|---|---|---|
| 1 | Entrada actual de mensajes | `src/modules/webhooks/webhook.controller.js:214` `gupshupWebhook()` — ACK 200 inmediato, luego `inboundGateway.handle(payload)` fire-and-forget (sin `await` respecto a la respuesta HTTP) |
| 2 | Resolución de tenant | `src/modules/channels/channel.resolver.js#resolve()` (Channel real por `phoneNumberId`/`wabaId`/`appName`) → `src/modules/channels/tenant.resolver.js:20` `resolve(channel)` (valida `Business.findOne({_id: channel.tenantId, isActive:true})`, nunca confía en el `tenantId` del channel "por transitividad") |
| 3 | Llamada actual al LLM | `src/modules/ai/ai.service.js:473` `generateReply(conversationId, business, lead)` — `openai.chat.completions.create()` en `ai.service.js:505`, dentro de un loop `for` (línea 504) |
| 4 | Tool/function calling | `src/modules/ai/tools/index.js` — `TOOL_SCHEMAS` (línea 46), `TOOL_EXECUTORS` (línea 445), `executeToolCall()` (línea 466, nunca lanza) |
| 5 | Product Intelligence | `src/modules/products/product.service.js` (`buscarProductos`/`consultarStock`/`consultarPrecio`), consumido por 3 tools en `ai/tools/index.js` (`search_products`/`check_stock`/`get_price`) |
| 6 | `search_business_knowledge` | `ai/tools/index.js#searchBusinessKnowledge()` → `src/modules/business-knowledge/knowledgeRetrieval.service.js#resolverConocimiento()` |
| 7 | `escalate_to_human` | `ai/tools/index.js#escalateToHuman()` — muta `conversation.status/aiEnabled/escalatedAt` en memoria, sin `save()` propio (lo persiste el único `save()` de `generateReply()`) |
| 8 | Conversation/message services | **No existe un `conversation.service.js` separado** — `ai.service.js` ES el servicio de conversación/mensajería (`saveInboundMessage`, `generateReply`, `chat`, `sendAgentMessage`, `sendTemplateMessage`, `sendMediaMessage`, `qualifyLead`) sobre `src/modules/ai/conversation.model.js` |
| 9 | Redis/BullMQ/queues existentes | Ver §2 completo — infraestructura real y madura, ya en producción para otro subsistema (automatizaciones), apagada por flag para WhatsApp inbound/outbound |
| 10 | Logging/tracing | `src/utils/logger.js` — winston, JSON estructurado en producción, `defaultMeta:{servicio:'creaos-api'}`. **Sin correlationId/requestId en ningún punto del pipeline.** Un `traceId` local y aislado ya existe en `knowledgeRetrieval.service.js:232` (ver §4) |
| 11 | RBAC/autorización | `src/middleware/rbac.middleware.js` (`checkPermission`, línea 12; `checkRole`, línea 52) + `src/config/constants.js` (`PERMISSIONS`/`ROLE_PERMISSIONS`) — capa HTTP únicamente, nunca se toca dentro del loop del agente (correcto: el LLM no decide permisos, ver regla #3 de la spec) |

---

## 2. Redis/BullMQ — infraestructura real, mucho más madura de lo esperado

Esto es la sorpresa más grande de la auditoría frente a lo que se sabía al cierre de C.2: **no hay que evaluar si construir queues — ya existen, completas, y ya están en producción para otro subsistema.**

- `src/config/queue.js`: conexión Redis dedicada para BullMQ (separada del cliente de cache de `ChannelResolver`), `DEFAULT_JOB_OPTIONS` con 3 reintentos + backoff exponencial (2s/4s/8s), dead-letter queue real.
- `QUEUE_NAMES` ya declara **4 colas**: `whatsapp-inbound`, `whatsapp-outbound`, `whatsapp-dead-letter` — apagadas por flag — y **`automation-sweep`/`automation-execute`, que SÍ están vivas en producción hoy** (motor de automatizaciones, Caso 7 del backlog).
- `src/modules/channels/queues/inbound.queue.js` + `workers/inbound.worker.js`: consumidor completo con idempotencia real (`InboundEvent` con índice único por `providerMessageId`, estados `received→processing→processed/failed`), detección de reintentos ya procesados (`OutboundEvent.findOne({sourceInboundEvent})` antes de volver a llamar a la IA), y manejo de dead-letter al agotar reintentos.
- `src/modules/channels/queues/outbound.queue.js` + `workers/outbound.worker.js`: reclamo atómico vía `findOneAndUpdate({status:'pending'}, {status:'processing'})` — cierra la carrera de doble-envío por WhatsApp ante un job reasignado tras un crash del worker.

Esto **no es infraestructura a medio construir**: es un sistema completo, con los mismos cuidados de idempotencia/concurrencia que ya se exigieron en Product Intelligence/C.2. La única razón por la que no está en producción es una decisión deliberada de flag, documentada explícitamente en el propio código (`inbound.gateway.js:11-25`).

### Respuesta directa a la sección 11 de la spec

- **¿El webhook espera al LLM hoy?** No, a nivel de respuesta HTTP — `gupshupWebhook()` responde 200 antes de llamar a `inboundGateway.handle()` (fire-and-forget con `.catch()`). Meta/Gupshup nunca esperan al LLM.
- **¿Existe BullMQ/Redis utilizable?** Sí, ya en producción, para automatizaciones. Cero riesgo de introducir una tecnología nueva.
- **¿Qué trabajos necesitan durabilidad?** El único riesgo real: si el proceso del web server muere **entre el ACK y que `generateReply()` termine**, el `InboundEvent` (si el camino síncrono lo llegara a crear — sí lo crea, ver `inbound.gateway.js:73-93`, independiente del flag) queda huérfano en `'processing'` para siempre, sin reintento automático. **No hay ningún incidente de este tipo documentado en `docs/implementation/known-issues.md`** — es un riesgo teórico y real por diseño, no un problema reportado en producción.
- **¿Se puede mover el runtime a worker sin romper el flujo actual?** Sí — el mecanismo ya existe y ya fue diseñado exactamente para esto. Lo que falta es cerrar 2 gaps concretos antes de poder prender el flag con confianza (ver §3).

**Recomendación:** no construir queues en C.3 — ya existen. Encender `WHATSAPP_QUEUE_PROCESSING_ENABLED` es una decisión operativa (no de código) que debería ser una **subfase C3.x separada, posterior**, nunca mezclada con el primer PR del runtime — exactamente como pide la spec. Antes de encenderlo hace falta corregir los gaps de §3.3.

---

## 3. Matriz de clasificación A–F

| # | Componente (spec) | Estado real | Clasificación | Evidencia |
|---|---|---|---|---|
| 3.1 | Agent Runtime Contract (`runAgent`/`AgentRunResult`) | Existe como `IAgentRuntime.process()`/`DefaultAgentRuntime`, con forma de entrada/salida DISTINTA a la de la spec (`{reply, actions, aiEnabled, metadata}` vs `{outcome, responseText, toolsUsed, knowledgeSources, correlationId}`) y **no es el camino que corre en producción** | **B** | `agentRuntime.interface.js`, `defaultAgentRuntime.js`, `inbound.worker.js:174` |
| 3.2 | `generateReply()` como orquestador de facto | Ya construye contexto, expone tools, corre el ciclo, limita iteraciones, compone resultado — falta exponer `outcome`/`toolsUsed`/`knowledgeSources`/`correlationId` | **B** | `ai.service.js:473-585` |
| 3.3 | `DefaultAgentRuntime` con `businessContext` incompleto | **Gap real y concreto**: `inbound.worker.js:242-249` construye `businessContext` con solo 6 campos (`name, productDescription, targetCustomer, pdfSummary, pdfExtractedText, aiInstructions`) — **le faltan `_id` y `aiPersonality`**, ambos usados por `ai.service.js` (`business._id` en CADA tool de Product Intelligence/Business Knowledge; `business.aiPersonality` en `buildSystemPrompt()`). Si se prendiera `WHATSAPP_QUEUE_PROCESSING_ENABLED` hoy tal cual, **todas las tools de Product Intelligence y Business Knowledge romperían en silencio** (`business: undefined` en cada query Mongo) y la personalidad configurada por el negocio se ignoraría siempre | **E — riesgo/bloqueador** (solo si se activa el flag; hoy inactivo, sin impacto en producción) | `inbound.worker.js:242-249` vs `ai.service.js` grep de `business.\w+` |
| 3.4 | Tool Registry | `TOOL_SCHEMAS`+`TOOL_EXECUTORS`+`executeToolCall()` ya cumplen "el modelo pide, el runtime decide" y fail-soft — falta el campo `authorization`/`timeout` formal por tool (hoy: todas las tools disponibles siempre, sin gating por plan/negocio; sin timeout por ejecución) | **B** | `ai/tools/index.js:46,445,466` |
| 3.5 | Orchestrator (loop, límite, no-loops) | Loop + `MAX_TOOL_ITERATIONS=5` ya existen; al agotarse, **lanza una excepción** en vez de degradar a un outcome explícito (`"error"` u `"handoff"`) | **D — requiere refactor menor** | `ai.service.js:584` |
| 3.6 | Action Decision (ANSWER/CLARIFY/ACTION/HANDOFF) | No existe como enum explícito. Hoy el "outcome" se infiere indirectamente: `reply` con texto = answer/clarify (indistinguibles), `escalate_to_human` ejecutado = handoff, excepción = error no mapeado | **C** | `ai.service.js` completo |
| 3.7 | Trace / `AgentRunTrace` / `correlationId` | No existe un correlationId end-to-end. Existe un patrón aislado y local: `knowledgeRetrieval.service.js:232` genera su propio `traceId` por llamada, sin propagarlo desde el webhook ni hacia los logs de nivel superior | **C** (correlationId end-to-end) / **B** (patrón de traceId ya probado en un punto aislado) | `knowledgeRetrieval.service.js:218,232,250,259` |
| 3.8 | Logging/observabilidad de base | winston con JSON estructurado en producción, ya usado con criterio `logger.info()` para eventos de negocio (`POLICY_IMPORT_STARTED`, etc., decisión #3 de C.2) — suficiente para construir Trace encima, spec §5.5 lo permite explícitamente | **A** (como base a extender, no como Trace en sí) | `utils/logger.js` |
| 3.9 | Tenant isolation fuera del prompt | `tenant.resolver.js:20` valida activamente contra `Business` en cada resolución, nunca confía en un valor copiado. El LLM nunca recibe ni puede fijar `business._id`/`tenantId` — siempre viene de `context.business`, resuelto antes del loop | **A** | `tenant.resolver.js`, `ai/tools/index.js` (todas las tools reciben `business` del contexto, nunca de `args`) |
| 3.10 | Guard `assertTenantScope()` sin usar | Existe, documentado como "usado en cada hand-off entre capas del pipeline" pero **nunca se llama desde ningún código real** — solo tiene su propio test unitario aislado | **B — existe pero no está conectado** | `tenant.resolver.js:39` (definición) vs 0 resultados de uso real fuera de `tenant.resolver.test.js` |
| 3.11 | Product Intelligence a través del runtime | Funciona hoy a través de `generateReply()` (el orquestador de facto), en producción | **A** | Etapas 2-9 de Product Intelligence, ya verificado en su propio cierre |
| 3.12 | Business Knowledge a través del runtime | Ídem — funciona a través de `generateReply()`, en producción, con aislamiento multi-tenant verificado (C.2, Etapas 3/4/10) | **A** | Etapas de C.2, ya verificado |
| 3.13 | Handoff a través del runtime | `escalate_to_human` ya es una tool más del mismo registro, reutilizada tal cual por Business Knowledge (C.2 Etapa 7) sin código nuevo | **A** | `ai/tools/index.js#escalateToHuman()`, Etapa 7 de C.2 |
| 3.14 | Consultas mixtas | Ya verificado en producción (C.2 Etapa 8, TC-11) — el mismo loop multi-tool ya combina dominios sin cambios | **A** | Etapa 8 de C.2 |
| 3.15 | RBAC/autorización | Capa HTTP (`checkPermission`), nunca contaminada dentro del loop del agente — correcto respecto a la regla "el LLM no decide permisos" | **A** | `rbac.middleware.js`, `ai.service.js` (sin ninguna referencia a `req.user`/permisos dentro del loop) |
| 3.16 | Colas (Redis/BullMQ) | Completas, maduras, en producción para otro subsistema, apagadas por flag para WhatsApp — ver §2 | **B** (existen, correctas, pero no es el camino activo) | §2 completo |
| 3.17 | M43-M50 como "arquitectura a implementar literal" | Documentos de formalización IA con artefactos de citación (`fileciteturn...`) en 6 de 8; proponen mucho más de lo que la spec pide (grafo de ejecución M46, multi-agente M46, event sourcing/Outbox M47, Policy Engine formal M49) — la propia spec ya anticipa y descarta esto explícitamente en su §7 y §11 | **F — fuera de alcance de C.3 V1** (documentado, no ignorado) | Reporte completo del sub-agente, sección "Resumen" |

---

## 4. Contradicciones entre la spec y el código real (documentadas, no forzadas)

1. **`AgentRuntimeOutput` actual vs. `AgentRunResult` deseado**: la spec pide `outcome`/`toolsUsed`/`knowledgeSources`/`correlationId`; lo que existe hoy (`DefaultAgentRuntime`) devuelve `{reply, actions, aiEnabled, metadata}`. No son incompatibles — `AgentRuntimeOutput` puede extenderse sin romper a su único consumidor real (`inbound.worker.js`, hoy inactivo) — pero hay que decidir si se extiende ese contrato o se reemplaza por uno nuevo que envuelva a `generateReply()` directamente (ver plan, C3.1).
2. **El camino "runtime formal" no es el camino en producción.** La spec asume implícitamente que consolidar/extender "el runtime que ya existe" alcanza — pero el runtime con la forma más cercana a la spec (`DefaultAgentRuntime`) es precisamente el que está apagado. El camino activo (`processGupshupMessage()`) llama a `generateReply()` sin ninguna capa de runtime encima. Cualquier PR de C3.1 tiene que decidir explícitamente: ¿el runtime formal envuelve `generateReply()` en AMBOS caminos (activo e inactivo), o solo se consolida el que ya existe y se deja pendiente unificar los 2 caminos para una subfase posterior? (Recomendación en §6: unificar ambos caminos es de bajo riesgo y cierra la deuda técnica ya documentada en el propio código — `inbound.worker.js:23-30` — de tener 2 copias de la lógica de Lead/Conversation).
3. **M44 nombra una tool catalog de 12 funciones que no incluye `search_business_knowledge` ni `escalate_to_human`** (las 2 tools que la spec dice explícitamente que ya son reales). Esto confirma que M44 es documentación conceptual anterior a C.2, no un contrato a seguir literalmente — la spec ya lo resuelve correctamente al decir "V1 debe incorporar primero las capacidades ya reales" (§5.2).
4. **M46/M47 contradicen directamente la sección 7 ("qué no construir") de la propia spec** — grafo de ejecución con nodos/edges, futuro multi-agente, Outbox/event sourcing. La spec ya se protege de esto explícitamente citando a M47 por nombre en su §11. Se documenta la tensión, no se sigue M46/M47 al pie de la letra.

---

## 5. Riesgos identificados (multi-tenant / seguridad / idempotencia / runtime / regresión)

1. **[Multi-tenant/E]** `DefaultAgentRuntime.process()` hace `Lead.findById(input.leadId)` **sin filtrar por `business`/`tenantId`** — confía en que el caller (`inbound.worker.js`) ya haya resuelto el par lead/tenant correctamente. No es explotable hoy (el único caller construye ambos valores en el mismo flujo, desde el mismo `channel` resuelto), pero es una superficie sin defensa-en-profundidad — el propio `assertTenantScope()` ya escrito (hallazgo 3.10) fue pensado exactamente para este punto y nunca se conectó.
2. **[Idempotencia/B — ya resuelto]** Ambos workers (inbound/outbound) ya tienen guardas de idempotencia reales y probadas (índice único + `findOneAndUpdate` atómico). No hay gap acá — se documenta como referencia positiva para el diseño del Trace (mismo criterio de "nunca proceses dos veces el mismo run").
3. **[Runtime/E, condicional]** Si se activa `WHATSAPP_QUEUE_PROCESSING_ENABLED` sin corregir §3.3, **todas las respuestas de Product Intelligence y Business Knowledge se romperían en silencio** en el camino asíncrono (business._id undefined). Bloqueante solo para esa activación futura, no para producción actual.
4. **[Regresión/A — bajo riesgo]** Ningún PR propuesto en §6 necesita tocar `ai.service.js#generateReply()` de forma que cambie su comportamiento externo en la Etapa C3.1 — se trata de envolver, no de reescribir. El riesgo de regresión real está concentrado en C3.3 (Action Decision) si se decide mapear el límite de iteraciones a un outcome distinto de excepción — ese cambio SÍ altera comportamiento observable (qué le llega al caller cuando el loop se agota) y necesita tests dedicados antes/después.
5. **[Seguridad/A]** Ninguna tool recibe ni puede fijar el tenant desde `args` — confirmado en las 6 tools reales de `ai/tools/index.js`. Ninguna acción con efecto real (escalar, cambiar etapa) se ejecuta sin pasar por `executeToolCall()`. Esto ya cumple la regla no-negociable #3 de la spec.

---

## 6. Plan de implementación por PRs — mismo tamaño de paso que Product Intelligence/C.2

| Etapa | Contenido | Riesgo | Se apoya en (reutiliza) |
|---|---|---|---|
| **C3.0 — Auditoría** ✅ | Este documento. | — | — |
| **C3.1 — Runtime Contract** | Formalizar `AgentRunResult` (`outcome`/`toolsUsed`/`knowledgeSources`/`correlationId`) como el tipo de retorno real de una función `runAgent()` que envuelve `generateReply()` **en el camino que hoy corre en producción** (`processGupshupMessage()`), sin cambiar su comportamiento externo observable (mismo `reply`, mismo guardado). `generateReply()` se modifica para ACUMULAR `toolsUsed`/`knowledgeSources` durante el loop (ya tiene toda la información, solo falta recolectarla) y devolverlos junto con `reply`/`tokensUsed`. Genera un `correlationId` (uuid) al entrar y lo loguea. **No** se toca `DefaultAgentRuntime`/Worker en esta etapa — eso es C3.1b. | Bajo — envoltorio puro, mismos tests existentes deben seguir en verde | `generateReply()` tal cual, sin reescritura |
| **C3.1b — Unificar el camino de Worker (opcional, puede diferirse)** | Actualizar `DefaultAgentRuntime`/`inbound.worker.js` para usar `runAgent()` de C3.1 en vez de `generateReply()` directo, y corregir el gap de `businessContext` (§3.3: agregar `_id`/`aiPersonality`, o mejor, pasar el `Business` completo en vez de un objeto recortado). Deliberadamente separado de C3.1 porque toca el camino INACTIVO — cero riesgo de romper producción, pero requiere tests propios antes de siquiera considerar activar el flag. | Bajo (camino inactivo) pero requiere tests nuevos | `DefaultAgentRuntime` ya existente |
| **C3.2 — Tool Registry** | Formalizar `TOOL_SCHEMAS`/`TOOL_EXECUTORS` existentes bajo un array de `ToolDefinition` con `name/description/inputSchema/authorization/execute` — sin agregar tools nuevas ni ficticias. `authorization` V1 = siempre `true` para las 6 tools reales (ya es el comportamiento actual); dejar el campo declarado para uso futuro, no implementar gating por plan todavía (fuera de alcance, no pedido). | Muy bajo — refactor de forma, no de comportamiento | `ai/tools/index.js` tal cual |
| **C3.3 — Orchestrator + Action Outcomes** | Mapear el resultado de `runAgent()` a los 4 outcomes (`answer`/`clarify`/`action`/`handoff`) + `error`. Reglas de mapeo concretas: `escalate_to_human` ejecutado → `handoff`; excepción por `MAX_TOOL_ITERATIONS` agotado → `error` (ya no lanza, se captura y se degrada); resto → `answer` (C.3 V1 no distingue `answer` de `clarify` a nivel de outcome — ambos son texto libre del modelo; distinguirlos requeriría heurística nueva, fuera de alcance de "sin cambiar comportamiento funcional"). Este es el único PR de la lista con cambio de comportamiento observable real (el `throw` deja de propagar como excepción no capturada) — necesita tests dedicados de regresión en `webhook.service.js`/`inbound.worker.js` para confirmar que ambos callers siguen manejando el nuevo shape correctamente. | Medio — único cambio de comportamiento real del plan | `escalate_to_human` ya existente, sin lógica nueva de decisión |
| **C3.4 — Trace** | `logger.info('AGENT_RUN', {correlationId, tenantId, conversationId, leadId, toolsUsed, outcome, durationMs, errorCode})` al final de `runAgent()` — mismo criterio `logger.info()` ya usado por C.2 (decisión #3), no una plataforma de observabilidad nueva. Sin persistir chain-of-thought (regla #9). | Muy bajo — solo logging aditivo | `utils/logger.js` tal cual |
| **C3.5 — Evaluation Harness** | Implementar los 10 escenarios mínimos de la spec §8 como tests de integración (mismo patrón que `ai.service.generateReply.*.test.js` ya existente — OpenAI mockeado, ejecución real del loop) — no un framework de evals nuevo, son tests de Jest adicionales sobre el mismo runtime. | Bajo — solo tests nuevos | Patrón de test ya usado en C.2 Etapas 7/8/10 |
| **C3.6 — Pilot Hardening** | Correr suite completa, confirmar 0 regresiones sobre el baseline de 809 tests + los nuevos de C3.1-C3.5, y una pasada de los 10 escenarios de evaluación contra producción-shadow o staging si existe. | — | Mismo criterio de cierre que C.2 |

**Nota explícita sobre Queues:** no aparecen como etapa de este plan porque ya existen (ver §2). Activar `WHATSAPP_QUEUE_PROCESSING_ENABLED` en producción es una decisión operativa posterior a C3.1b, nunca parte de C3.1.

---

## 7. Preservación de los 809 tests existentes + tests nuevos propuestos

**Preservación:** ningún PR de C3.1 a C3.4 reescribe `generateReply()`, `executeToolCall()`, `escalateToHuman()`, `tenant.resolver.js`, ni ningún servicio de Product Intelligence/C.2 — se envuelven o se les agrega una recolección de datos ya disponibles (tools usadas, knowledge sources). El comportamiento externo (`reply`, guardado de `conversation.messages`, aislamiento multi-tenant) debe seguir siendo IDÉNTICO byte a byte en C3.1/C3.2/C3.4 — verificable corriendo la suite completa sin ningún cambio esperado en el conteo de tests existentes. El único punto con cambio de comportamiento real es C3.3 (ver arriba), y ahí se exige explícitamente un test de regresión antes/después en los 2 callers reales.

**Tests nuevos por etapa (estimado, a confirmar en cada PR):**
- C3.1: tests de `runAgent()` verificando que `toolsUsed`/`knowledgeSources`/`correlationId` se pueblan correctamente para los 3 casos ya cubiertos (Product Intelligence, Business Knowledge, mixto) — reusando las conversaciones mockeadas ya escritas en Etapas 7/8 de C.2, solo agregando assertions nuevas sobre el shape de salida.
- C3.1b: tests del `DefaultAgentRuntime` corregido con `businessContext` completo (confirmar que las tools de Product Intelligence/Business Knowledge SÍ funcionan a través del Worker, cerrando el gap de §3.3).
- C3.2: test de que `TOOL_SCHEMAS`/`TOOL_EXECUTORS` formalizados siguen exponiendo exactamente las mismas 6 tools con el mismo comportamiento (regresión de forma, no de contenido).
- C3.3: tests de mapeo de outcome para los 4 casos + el caso de error (loop agotado) — TC-09 (handoff) y TC-07 (fallback) de C.2 ya sirven de base, se les agrega la assertion de `outcome`.
- C3.4: test de que el log de trace se emite con los campos correctos, sin chain-of-thought.
- C3.5: los 10 escenarios de la spec §8, como archivos de test nuevos (`ai.service.evaluationScenarios.*.test.js` o similar).

Ningún test existente debería requerir modificación — solo adición.

---

## 8. Lo que NO se toca (confirmado explícitamente)

- `generateReply()` no se reescribe, se envuelve.
- `ai/tools/index.js` no gana tools nuevas ni ficticias.
- No se crea un nuevo sistema de RBAC, tenant isolation, Product Intelligence o Policies/FAQ.
- No se implementa el grafo de ejecución de M46 ni el modelo multi-agente que M46 sugiere a futuro.
- No se implementa el patrón Outbox/event sourcing que M47 sugiere.
- No se construyen queues nuevas — ya existen.
- No se activa `WHATSAPP_QUEUE_PROCESSING_ENABLED` en este plan — es una decisión operativa posterior, separada.
- No se implementan M38-M42 (Buyer/Psychological/Objection/Micro-Closing/Conversational Memory) completos.
- No se hardcodea ningún `businessId` en ningún PR propuesto.

---

## 9. Estado

Auditoría completa. Hipótesis del usuario confirmada con matices documentados en §0. Plan de 6 etapas (C3.1-C3.6) propuesto, más una C3.1b opcional/diferible para el camino de Worker. Queues analizadas por separado (§2) — ya existen, no requieren construcción, activación queda fuera del alcance de C.3 V1. Ningún código fue modificado. **Esperando aprobación explícita antes de tocar código.**
