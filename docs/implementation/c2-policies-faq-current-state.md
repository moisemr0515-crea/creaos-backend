# C.2 — Business Brain: Policies + FAQ V1 — Auditoría del estado actual

**Fecha:** 12/sep/2026
**Alcance de este documento:** SOLO auditoría — ningún código de producción fue tocado. Ningún commit, ninguna rama de trabajo abierta.
**Fuente:** `docs/business-brain/CREA_SALES_AI_C2_Business_Brain_Policies_FAQ_V1_Implementation_Spec.md` (1901 líneas, leída completa) + módulos M01, M02, M18, M20, M37, M44, M47, M48, M49 (leídos — ver metodología) + auditoría directa del repositorio real.

---

## 0. Metodología

1. Leí la Implementation Spec completa (las 50 secciones + 3 anexos).
2. Leí M01 (Identidad/ADN) y M18 (System Rules) completos o casi completos — son los más concretos en reglas de comportamiento (no inventar, conflicto de información, tenant).
3. Para M02, M20, M37, M43–M50 (12 archivos, **32.026 líneas combinadas**, más M02 con 1184), hice lectura de tabla de contenidos + secciones directamente relevantes a Policy/FAQ/Tool/Tenant/Security (no las 32.000 líneas palabra por palabra). Razón, con evidencia: cada sección muestreada (M20 §19 Policies, M20 §22 FAQ, M37 §5-7 Multi-tenant, M37 §23 Policies, M37 §26 FAQ, M44 §8-17 principios de tools, M48 §7-13 Tenant/Business/Ownership, M48 §37 Policy, M49 §5-7 Tenant Resolution/Zero Trust, M49 §25-27 AI as untrusted actor/Tenant isolation) contiene **exactamente la misma sustancia, más resumida y ya formalizada**, en la propia Implementation Spec (§4, §6, §7, §13, §16, §36, secciones que cité). Encontré además artefactos literales de generación por IA (`fileciteturn18file7`, `fileciteturn31file13`, etc.) en estos módulos — confirma lo ya documentado en la auditoría original de `docs/modules/` (son una formalización generada, no diseño técnico original). No hay ninguna sección de estos módulos que contradiga o agregue una regla técnica nueva no capturada ya por la Spec.
4. Auditoría del repositorio real: grep exhaustivo de `Policy|FAQ|BusinessKnowledge` (cero resultados en `src/`), lectura de modelos (`Business`, `Product`, `Conversation`, `Lead`), servicios de IA (`ai.service.js`, `ai/tools/index.js`), capa de Channel Core (`inbound.gateway.js`, `agentRuntime.interface.js`, `defaultAgentRuntime.js`, `inbound.worker.js`), RBAC (`constants.js`, `roles.seed.js`, `rbac.middleware.js`), e infraestructura (`config/queue.js`, `config/redis.js`).
5. Cruce con CREA Product Intelligence V1.0 (ya implementado y mergeado, Etapas 2-9) como referencia directa de patrón.

---

## 1. Hallazgo central: NO existe ningún vestigio de código para Policy/FAQ

```
grep -rn "Policy|FAQ|faq|BusinessKnowledge" src/   →   0 resultados
```

Esto es consistente con la Spec (que asume que se parte de cero) y con la auditoría original de `docs/modules/` de esta misma sesión (nada del tier "Architecture", M34-50, tiene código real).

**Lo que sí existe, y es la fuente real de "conocimiento del negocio" hoy** (spec §39: "inventariar antes de migrar"):

| Fuente actual | Dónde | Naturaleza | Problema respecto a la Spec |
|---|---|---|---|
| `Business.aiInstructions` | [`business.model.js:120-125`](src/modules/businesses/business.model.js:120) | Texto libre, máx 1500 caracteres, un solo campo por negocio | Sin estructura, sin categoría, sin vigencia, sin scope, sin tenant-isolation propia más allá de vivir en el doc de `Business` (que sí está aislado), inyectado siempre completo al prompt (nunca "recuperado" selectivamente) |
| `Business.productDescription` | [`business.model.js:94-99`](src/modules/businesses/business.model.js:94) | Texto libre, máx 500 caracteres | Es descripción de qué vende, no política — mezclable en la práctica pero conceptualmente distinta |
| `Business.pdfSummary` / `pdfExtractedText` | [`business.model.js:38-50`](src/modules/businesses/business.model.js:38) | Texto extraído de un PDF subido por el dueño (`pdf-parse`), resumido una vez por OpenAI ([`business.service.js:20`](src/modules/businesses/business.service.js:20)) a 800 caracteres | Puede contener políticas/FAQs mezcladas con cualquier otro contenido del PDF, sin ninguna extracción estructurada — es prosa libre inyectada siempre entera |

Estas 3 fuentes se inyectan **siempre completas** en cada turno vía `buildSystemPrompt()` ([`ai.service.js:300`](src/modules/ai/ai.service.js:300), bloque "INFORMACIÓN DEL NEGOCIO" e "INSTRUCCIONES ESPECÍFICAS DEL DUEÑO") — el patrón exacto que la Spec §13 prohíbe para conocimiento a escala ("el agente no debería recibir toda la base de conocimiento en el system prompt"). Hoy es manejable porque son 3 campos cortos; **no escala** a un catálogo de políticas/FAQs reales, que es precisamente el problema que C.2 resuelve.

**Implicación para la migración (spec §39):** no hay ningún registro previo de Policy/FAQ que migrar formalmente — solo texto libre en 3 campos. Recomiendo NO intentar auto-extraer políticas de `aiInstructions`/`pdfSummary` con el LLM como parte de V1 (la Spec lo prohíbe explícitamente en el mismo espíritu que "no permitir que un PDF subido se convierta automáticamente en política activa sin revisión humana", §18). Se documenta como fuente conocida; la carga real a Policy/FAQ structured queda como trabajo manual del dueño del negocio en V1, igual que ya se decidió para el catálogo de productos.

---

## 2. Lo que SÍ es directamente reutilizable (evidencia código:línea)

Esta es la sección más importante del documento: casi toda la infraestructura que C.2 necesita **ya existe**, construida para CREA Product Intelligence V1.0. La Spec (§43, §1.2) pide exactamente esto.

### 2.1 Tenant resolution — reutilizar tal cual, cero cambios

- El campo canónico de aislamiento es `business` (ObjectId ref `Business`) — **no** `tenantId` como sugiere la Spec genéricamente. Ya validado en `Lead`, `Conversation`, `Pipeline`, `Product`.
- `Conversation.tenantId` es un campo **separado y todavía opcional** ([`conversation.model.js:128`](src/modules/ai/conversation.model.js:128), migración en curso desde antes de esta sesión) — **no** es el identificador real de tenant hoy; es deuda técnica conocida, no un patrón a replicar.
- El tenant nunca lo elige el LLM: `ai.service.js#generateReply(conversationId, business, lead)` recibe `business` ya resuelto por el caller (Channel Core → `webhook.service.js`/`inbound.worker.js`/`defaultAgentRuntime.js`), nunca desde `args` del modelo. Las 3 tools de Product Intelligence (`search_products`/`check_stock`/`get_price`) usan exclusivamente `context.business._id` — verificado con test explícito que un `businessId` falso en `args` se ignora ([`ai/tools/index.test.js`](src/modules/ai/tools/index.test.js), caso "NUNCA acepta un tenant/businessId desde args").
- **Esto satisface exactamente la Spec §4.1, §13, y M49 §25 ("AI can propose, system must authorize") sin escribir una sola línea nueva** — el mecanismo estructural que la Spec pide ya está construido y probado.

### 2.2 Tool-calling — reutilizar el registro existente, no crear infraestructura paralela

- [`ai/tools/index.js`](src/modules/ai/tools/index.js) exporta `TOOL_SCHEMAS` (array, línea 46), `TOOL_EXECUTORS` (mapa nombre→función, línea 445) y `executeToolCall()` (línea 466) — **nunca lanza**, siempre devuelve `{success, ...}` o `{success:false, error}` (fail-soft).
- Hoy registra 5 tools: `escalate_to_human`, `update_lead_stage` (PR33/38), `search_products`, `check_stock`, `get_price` (Product Intelligence, Etapa 6).
- `ai.service.js#generateReply()` ([línea ~450-478](src/modules/ai/ai.service.js:450)) tiene un **loop real multi-ronda** (`MAX_TOOL_ITERATIONS = 5`, [línea 20](src/modules/ai/ai.service.js:20)) — el modelo ya puede encadenar `search_business_knowledge` → (opcionalmente) `search_products` en el mismo turno, sin ningún cambio al loop. Esto es exactamente lo que la Spec §1.2/§11 pide para consultas mixtas ("¿tienen stock de X y puedo devolverlo?").
- Clasificación M44 (§17, READ/WRITE/EXTERNAL): una tool de búsqueda de conocimiento es **READ pura** — mismo tipo que `search_products`/`check_stock`/`get_price`, ninguna complejidad de side-effects que gestionar.
- **Acción concreta:** agregar 1 (o como mucho 2) tools nuevas a este mismo archivo, exactamente con el mismo patrón — no un "Tool Engine" nuevo, no un framework de agentes nuevo.

### 2.3 Conversational memory — reutilizar el patrón `activeProduct`, no crear sistema nuevo

- `Conversation.leadQualification` (subdocumento, [`conversation.model.js:101-116`](src/modules/ai/conversation.model.js:101)) y `Conversation.activeProduct` ([`conversation.model.js:173`](src/modules/ai/conversation.model.js:173), agregado en Etapa 6 de Product Intelligence) son el patrón exacto que la Spec §33 pide: "la memoria puede recordar CONTEXTO, nunca puede ser fuente de verdad de una política".
- El patrón de escritura es: el executor de la tool muta el subdocumento **en memoria** sobre el `conversation` que `generateReply()` ya tiene cargado, sin `save()` propio — `generateReply()` hace un único `save()` al final del loop. Ya probado con `search_products` (escribe `activeProduct` cuando encuentra resultados, nunca lo borra en una búsqueda sin resultados).
- **Acción concreta:** un subdocumento análogo (ej. `activeKnowledgeTopic` o reusar el mismo `activeProduct` extendido) para recordar "de qué producto/tema se venía hablando" cuando el lead pregunta algo ambiguo tipo "¿puedo devolverlo?" sin nombrar el producto — exactamente el Caso D de la Spec (§24).

### 2.4 Modelo de datos / servicio — reutilizar la forma, no el contenido

`Product` ([`product.model.js`](src/modules/products/product.model.js)) es el ejemplo vivo más reciente de "cómo se modela una entidad tenant-scoped, con estado, texto buscable y CRUD administrado" en este repo:

- `business` (ObjectId, `required:true`, indexado) — nunca `tenantId`.
- Índice único compuesto `{business:1, <clave-natural>:1}` (`{business,sku}` en Product) — para Policy sería `{business,code}` (la Spec pide exactamente esto, §6.2 regla 2).
- Índice de texto con `default_language:'spanish'` ([`product.model.js:89-92`](src/modules/products/product.model.js:89)) — necesario para que el stemming en español tolere singular/plural (mismo requisito que la Spec §8 pide para preguntas normalizadas). Directamente reutilizable para FAQ (`question`, `aliases`, `keywords`, `answer`).
- Campo `active`/estado como boolean simple, **nunca** un segundo booleano `isDeleted` en paralelo — decisión ya tomada y documentada (evita el caso ambiguo `isDeleted:true, active:true`). Para Policy/FAQ la Spec pide 3 estados (`draft/active/archived`), no 2 — esto es una diferencia real de forma, no de principio: usar un `status` enum de 3 valores en vez de un boolean, consistente con `Import.status` (`processing/completed/partial/failed`, ya un enum de string en este repo).
- `source: {type: 'manual'|'import'}` ([`product.model.js:63`](src/modules/products/product.model.js:63)) — mapea directo al `source.type` de la Spec (§6, `manual/import/connector/migration`; V1 solo necesita `manual`/`import`).
- `productImport.service.js` (Etapa 5) es el patrón completo y ya probado de **importación con preview real de 2 pasos** (parsear → validar fila por fila → mostrar resumen → confirmar explícito → recién ahí escribir, upsert por `{business, code}`) — exactamente lo que la Spec §18 pide para Policies/FAQs, sin inventar nada nuevo.

### 2.5 RBAC — reutilizar el patrón `<módulo>:<acción>`, no crear un segundo sistema de roles

- Permisos ya declarados como constantes en [`constants.js`](src/config/constants.js) (ej. `PRODUCTS_READ: 'products:read'`, línea 37) y asignados por rol en `ROLE_PERMISSIONS` (líneas 84-173).
- Seed espejo en `roles.seed.js` (`{module, action, slug, description}`).
- Middleware `checkPermission('<slug>')` ([`rbac.middleware.js`](src/middleware/rbac.middleware.js)) en cada ruta.
- **Esto satisface la Spec §16 sin crear nada nuevo** — "Claude Code debe mapear al RBAC real, no crear un segundo sistema de roles" ya tiene un mapeo directo: nuevo slug `business-knowledge:read/create/update/archive` (o `policies:*`+`faqs:*` separados — ver Decisión Abierta #1 más abajo), mismo patrón exacto que `products:*`.

### 2.6 Anti-alucinación en el prompt — reutilizar el patrón, extender el contenido

- `ai.service.js` ya tiene un bloque de guía SIEMPRE presente y no condicionado a que exista contenido (`PRODUCT_INTELLIGENCE_GUIDANCE`, [línea 223](src/modules/ai/ai.service.js:223)) con la regla anti-alucinación exacta que la Spec §32 pide como texto de prompt ("nunca inventes... si falta evidencia, decilo... pedí aclaración ante ambigüedad").
- **Acción concreta:** un bloque hermano (`BUSINESS_KNOWLEDGE_GUIDANCE`) con el mismo criterio, agregado a `buildSystemPrompt()` en el mismo lugar.

---

## 3. Contradicciones reales entre la Spec y el repositorio (documentadas, no resueltas en silencio)

La Spec pide explícitamente documentar cualquier contradicción antes de proponer solución. Encontré 4:

### 3.1 `tenantId` vs `business` — terminología, no solo nombre

La Spec usa `tenantId`/`Business` como conceptos **separados** (M48 §7-9: "un tenant puede tener varios businesses"). En el repo real, **no existe ningún concepto de Tenant distinto de Business** — `business` ES el límite de aislamiento completo, en todos los modelos, sin excepción, hoy. `Conversation.tenantId` es un campo aparte pero **apunta al mismo `Business`** (`ref: 'Business'`, [línea 128](src/modules/ai/conversation.model.js:128)), no a una entidad "Tenant" real.

**Impacto:** ninguno funcional — se resuelve usando `business` en todo el modelo de Policy/FAQ, exactamente como Product Intelligence ya decidió. Lo documento porque la Spec podría inducir a crear un campo `tenantId` paralelo que no correspondería a nada real en este repo (mismo error que ya se evitó explícitamente en Product Intelligence, ver comentario en `product.model.js:8-13`).

### 3.2 `scope.serviceIds` y `scope.locationIds` no tienen modelo real que referenciar

La Spec asume la existencia de un modelo `Service` (distinto de `Product`) y un modelo `Location`. **Ninguno de los dos existe** en el repositorio (`grep` sin resultados). `scope.productIds` sí tiene un destino real (`Product._id`). `scope.channelIds` sí tiene un destino real (`WhatsAppChannel._id`, Channel Core).

**Impacto:** `scope.serviceIds`/`scope.locationIds` no se pueden implementar como referencias reales hoy sin inventar 2 modelos nuevos fuera del alcance de C.2. Propongo (Decisión Abierta #2): en V1, `scope` solo soporta `appliesToAll`, `productIds` (real) y `channelIds` (real); `serviceIds`/`locationIds`/`customerSegments` quedan como campos de schema reservados/no usados (F — fuera de alcance V1), documentados como tal, no implementados a medias con una referencia que apunta a nada.

### 3.3 No existe infraestructura de eventos ni caché general — la Spec ya lo permite explícitamente

Confirmado por grep: cero `EventEmitter`/event bus en todo el repo (BullMQ existe, pero solo para 2 flujos async concretos: automatizaciones e inbound de WhatsApp — no es un bus de eventos de dominio). Cero uso de Redis fuera de backing de colas (`config/redis.js` solo lo consume `config/queue.js`).

**Impacto:** ninguno — la Spec permite explícitamente omitir ambos en V1 (§21 "caching es opcional", §22 "no construir un event platform completo"). Confirmo con evidencia que no hay ninguno preexistente que debiera reutilizarse; se sustituyen ambos por `logger.info()` estructurado, mismo patrón que `PRODUCT_IMPORT_STARTED/COMPLETED` de Product Intelligence.

### 3.4 El runtime de IA tiene 2 caminos posibles, ninguno relevante para el diseño de la tool

Encontré una pieza arquitectónica real que la Spec no menciona porque es interna a este repo: existe un contrato `IAgentRuntime` ([`agentRuntime.interface.js`](src/modules/channels/agentRuntime.interface.js)) con una implementación `DefaultAgentRuntime` ([`defaultAgentRuntime.js`](src/modules/channels/defaultAgentRuntime.js)) que es un envoltorio literal de `ai.service.js#generateReply()` — construido explícitamente (comentario en el propio archivo) para que **"Bloque C" lo reemplace después sin tocar Worker/Gateway**. "Bloque C" es, con altísima probabilidad, el mismo bloque al que pertenece esta tarea C.2 (nomenclatura idéntica al Plan Maestro).

El mensaje entrante de WhatsApp puede llegar por 2 caminos hoy, según el flag `WHATSAPP_QUEUE_PROCESSING_ENABLED` ([`inbound.gateway.js:7,17-20`](src/modules/channels/inbound.gateway.js:7)):
- `false` (default documentado): síncrono, `webhookService.processGupshupMessage()` directo.
- `true`: encola en BullMQ, un Worker separado llama `DefaultAgentRuntime.process()` → `generateReply()`.

**Impacto: ninguno para el diseño de la tool.** Ambos caminos terminan llamando exactamente a `ai.service.js#generateReply()`, que ya incluye `TOOL_SCHEMAS`/`executeToolCall()`. Una tool nueva registrada en `ai/tools/index.js` queda disponible en **ambos** caminos sin ningún cambio adicional — no hace falta tocar `DefaultAgentRuntime`, `agentRuntime.interface.js` ni el Worker. Lo documento porque es información real que la auditoría encontró y que confirma que el punto de integración correcto (§43, "reutilizar > extender > crear") es el mismo que ya usa Product Intelligence, no uno nuevo a nivel de Runtime.

**Nota aparte, fuera del alcance de C.2:** no verifiqué el valor real de `WHATSAPP_QUEUE_PROCESSING_ENABLED` en producción (no tengo acceso de solo-código a variables de entorno de Railway) — no lo necesito para este diseño, pero lo señalo para no dar por sentado cuál camino es el que corre hoy en producción real.

---

## 4. Matriz de clasificación (A/B/C/D/E/F) por requisito de la Spec

Leyenda: **A**=ya existe y cumple · **B**=existe parcialmente · **C**=no existe · **D**=existe pero requiere refactor · **E**=riesgo/bloqueador · **F**=fuera de alcance V1

| # | Requisito (sección Spec) | Clase | Evidencia / justificación |
|---|---|---|---|
| 1 | Modelo Policy persistente (§6) | **C** | No existe. Modelo `Product` es la plantilla directa a seguir. |
| 2 | Modelo FAQ persistente (§7) | **C** | No existe. Ídem. |
| 3 | Aislamiento multi-tenant en ambos (§4.1) | **A** (mecanismo) / **C** (modelo) | El *mecanismo* (`business` + `context.business` en tools) ya existe y está probado extensamente; el *modelo* que lo usaría no existe todavía — es "plug & play" una vez creado el modelo. |
| 4 | Estados draft/active/archived (§3.1.4) | **C** | `Product` usa boolean `active`; Policy/FAQ necesitan 3 estados → nuevo enum `status`, sin precedente de 3 estados exacto en este repo, pero sí de enums de string similares (`Import.status`). |
| 5 | Vigencia temporal (effectiveFrom/Until) (§9) | **C** | Sin precedente directo en ningún modelo de este repo. Lógica de comparación de fechas simple, sin riesgo técnico. |
| 6 | Prioridad y scope (§6, §10) | **C** | Sin precedente de "specificity ranking". `scope.productIds`/`channelIds` sí tienen modelo real que referenciar (ver 3.2); `serviceIds`/`locationIds` no. |
| 7 | Tags/categorías (§5) | **A** (patrón) | `Product.keywords`/`Product.category` son el mismo patrón exacto (array de strings + enum de categoría). |
| 8 | Búsqueda textual (§3.1.8, §11.1) | **A** (patrón, no infraestructura) | `$text` con `default_language:'spanish'` ya resuelto y probado en `Product`/`Lead`. Reutilizar tal cual para FAQ (`question`,`aliases`,`keywords`,`answer`) y Policy (`title`,`statement`,`tags`). |
| 9 | Búsqueda semántica/embeddings (§11.1) | **F** | Spec la marca opcional ("si ya existe infraestructura apropiada"). No existe ninguna infraestructura de embeddings en el repo. No introducir vector DB nueva — instrucción explícita de la Spec §43 y del usuario. |
| 10 | Retrieval con hard filters antes del LLM (§11.2, §4.1) | **A** (patrón) | Exactamente lo que ya hacen `buscarProductos()`/`consultarStock()`/`consultarPrecio()` — el filtro de tenant/estado ocurre en el `service`, nunca en el prompt. Reutilizar el patrón, escribir el filtro nuevo para Policy/FAQ (tenant + status + vigencia). |
| 11 | Resolución de conflictos / precedencia (§10) | **C** | No existe absolutamente ningún precedente de "resolución de conflicto entre 2 registros de conocimiento" en este repo. Es la pieza más nueva de todo el dominio. |
| 12 | Contrato de servicio interno (`BusinessKnowledgeService`) (§12) | **C** | No existe. `product.service.js` es la plantilla de forma (funciones puras async, sin controller/HTTP mezclado). |
| 13 | Contrato con el agente / tool (§13) | **B** | El *mecanismo* de tools (registro, ejecución fail-soft, loop multi-ronda) existe y es 100% reutilizable (clase A); la tool *específica* `search_business_knowledge` no existe (clase C). Marco B porque es la combinación de ambas. |
| 14 | tenantId no lo decide el LLM (§13, §16.1) | **A** | Ya garantizado estructuralmente para Product Intelligence; el mismo patrón (`context.business._id`) se hereda automáticamente al agregar la tool nueva de la misma forma. |
| 15 | Reglas de respuesta / anti-alucinación en prompt (§14, §32) | **B** | El *patrón* (`PRODUCT_INTELLIGENCE_GUIDANCE`, bloque fijo en `buildSystemPrompt()`) existe y es reutilizable; el *contenido* específico de Policy/FAQ no existe todavía. |
| 16 | Relación con Action Engine / Handoff (§15) | **B** | `escalate_to_human` (tool ya existente, PR33) es el mecanismo real de handoff — ya puede ser invocado como resultado de una Policy con `responseMode:"handoff"`. No existe un "Action Engine" formal que traduzca `responseMode`/`requiresHumanApproval` en una decisión estructurada — eso quedaría como lógica nueva dentro del executor de la tool, no como una pieza de arquitectura nueva. |
| 17 | Seguridad y RBAC (§16) | **A** (patrón) / **C** (permisos concretos) | Patrón 100% reutilizable; slugs `business-knowledge:*` o `policies:*`/`faqs:*` no existen todavía — trivial de agregar. |
| 18 | API REST (§17) | **C** | No existe. Patrón de `product.routes.js`/`product.controller.js` es la plantilla exacta. |
| 19 | Importación V1 con preview (§18) | **B** (patrón) / **C** (implementación) | `productImport.service.js` es la plantilla *completa y ya probada* del flujo preview→confirm de 2 pasos con upsert por clave natural — el trabajo real es adaptarlo a Policy/FAQ, no diseñarlo de cero. |
| 20 | Auditoría/trazabilidad (`KnowledgeUsageEvent`) (§19) | **C** | No existe un modelo de auditoría de uso de conocimiento. Precedente más cercano: `logger.info()` estructurado (Product Intelligence, `PRODUCT_IMPORT_*`) — la Spec explícitamente dice que no hace falta persistir cadena de razonamiento, solo qué se recuperó/usó; esto se puede resolver con logging estructurado en V1, sin nueva colección, si el usuario lo aprueba (ver Decisión Abierta #3). |
| 21 | Observabilidad (métricas) (§20) | **F** | No existe ninguna infraestructura de métricas (Prometheus/Datadog/etc.) en el repo hoy. Fuera de alcance real de V1 sin evidencia de que el resto de la plataforma ya mide algo — usar logs estructurados como sustituto mínimo, igual que el resto del sistema hoy. |
| 22 | Caché (§21) | **F** | Redis existe pero solo para colas; no hay capa de cache-aside en ningún módulo. La propia Spec lo marca opcional. No construir para V1 sin evidencia de necesidad de performance real. |
| 23 | Eventos internos (§22) | **F** | No existe event bus. La Spec permite omitirlo explícitamente. Sustituir por logging. |
| 24 | Migración de conocimiento existente en prompts/PDF (§39) | **B** (inventario hecho) / **F** (auto-migración) | Inventario de las 3 fuentes ya hecho en la sección 1 de este documento. Auto-extracción de políticas desde `aiInstructions`/`pdfSummary` vía LLM queda fuera de alcance V1 — la Spec la prohíbe implícitamente ("no migrar texto ambiguo automáticamente a active"). |
| 25 | Interoperabilidad con Memory (§33) | **A** (patrón) | `activeProduct` es la prueba de concepto ya funcionando de "memoria = contexto, nunca fuente de verdad". |
| 26 | Interoperabilidad con Product Intelligence — consultas mixtas (§1.2, TC-11) | **A** (infraestructura) / **C** (caso de uso concreto) | El loop multi-ronda ya soporta encadenar 2 tools de dominios distintos en el mismo turno (ya sucede hoy: `search_products`→`check_stock`→`get_price`); el caso concreto "producto + política" nunca se probó porque Policy no existe todavía. |
| 27 | Tests unitarios/integración/multi-tenant/conversacionales (§23, §24) | **C** | No existen (no hay código que testear). Convención de test 100% establecida y reutilizable: Jest + Mongo real, mismo patrón que cada módulo de Product Intelligence. |

---

## 5. Riesgos identificados

### 5.1 Multi-tenant

- **Riesgo real, mitigado por patrón ya probado:** si el nuevo modelo/servicio no sigue la misma disciplina que `product.service.js` (todo query con `{business: businessId, ...}` explícito, nunca confiar en un filtro "por convención"), se repite el mismo tipo de bug que ya se cazó y corrigió 2 veces esta sesión (el bug de casting `Lead.aggregate()` y el bug de `pipeline` ausente en leads huérfanos). Mitigación: mismos tests de aislamiento cross-tenant que ya se escriben para cada módulo nuevo (ver Etapa 2/6/9 de Product Intelligence como plantilla).
- **Riesgo específico de esta spec, no presente en Product Intelligence:** la resolución de conflictos/precedencia (ranking por especificidad + prioridad) es lógica nueva que cruza registros — si no se re-filtra por tenant en cada paso intermedio del ranking (no solo en la query inicial), un bug de "traer todos, filtrar después" podría filtrar tenant incorrectamente en una refactorización futura. Mitigación: mismo principio de "hard filter antes del LLM Y antes del ranking", nunca en el prompt.

### 5.2 Seguridad

- `scope.productIds` debe validarse contra `Product` del **mismo** `business` al crear/editar una Policy (igual que Product Intelligence ya valida referencias cruzadas en otros contextos) — si no se valida, un dueño de negocio podría (por error de copy-paste de otro sistema, no por malicia) crear una Policy que referencia un `productId` ajeno sin que nada lo detecte; el impacto real es bajo (no expone datos, solo un scope que nunca matchea nada) pero debe validarse explícitamente por higiene de datos.
- TC-13 de la Spec (ataque por ID: `/policies/{id-de-otro-tenant}`) — mismo patrón ya resuelto en `product.controller.js` (`obtenerProducto()` filtra por `{_id, business}` en la misma query, nunca en 2 pasos) — replicar tal cual.

### 5.3 Idempotencia

- La importación de Policy/FAQ debe seguir el mismo criterio que `productImport.service.js`: upsert por `{business, code}` (Policy) / `{business, normalizedQuestion}` (FAQ, con el riesgo de que 2 preguntas distintas se normalicen igual — a decidir si eso es error o merge, ver Decisión Abierta #4).
- No hay riesgo de idempotencia en el lado de la tool de lectura (`search_business_knowledge` es una operación de solo lectura, sin side effects — no necesita idempotency key).
- El runtime de inbound (Channel Core) no tiene, por lo que pude confirmar, deduplicación explícita por `providerMessageId` a nivel de mensaje — esto es una observación preexistente, **no introducida ni agravada por C.2**, y está fuera del alcance de esta auditoría arreglarla (igual que el hallazgo de invitación de usuarios de la sesión anterior: se documenta, no se toca sin que el usuario lo priorice aparte).

### 5.4 Runtime

- Agregar tools nuevas a `TOOL_SCHEMAS` aumenta los tokens que se mandan a OpenAI en cada turno (ya señalado como riesgo menor en la auditoría de Product Intelligence, ahí con 3 tools nuevas; ahora se sumaría 1-2 más). Sigue siendo un costo bajo en términos absolutos, pero acumulativo — a vigilar si en el futuro se agregan más dominios (Buyer Profile, Promotions, per el Anexo C de la Spec).
- El mismo hallazgo de `ai.service.js:383-386` que se corrigió en el fix `tool-messages-history-window` (mensajes `role:'tool'` truncados en el corte de los últimos 10 al reconstruir la ventana en un turno nuevo) ya está resuelto de forma genérica (`construirVentanaDeMensajes()`) — cualquier tool nueva que genere mensajes `role:'tool'` (incluida `search_business_knowledge`) queda automáticamente protegida por ese fix, sin trabajo adicional.

### 5.5 Regresión

- Ningún cambio propuesto toca `product.*`, `lead.*`, `pipeline.*` ni el loop de `generateReply()` en su forma (solo se le agregan entradas a `TOOL_SCHEMAS`/`TOOL_EXECUTORS`, exactamente como ya se hizo 3 veces esta sesión sin romper nada). Riesgo de regresión: bajo, con la misma verificación de siempre (suite completa antes de cada PR).

---

## 6. Decisiones confirmadas (11/sep/2026)

1. **RBAC separado:** `policies:read/create/update/archive` y `faqs:read/create/update/archive` (8 slugs), mismo nivel de granularidad que `products:*`. **No** se usa `business-knowledge:*` unificado. Asignación por rol: CRUD completo para Owner/Admin/Manager, solo `*:read` para Sales/Viewer, nada para Support — mismo criterio ya usado para `products:*` (gestión de catálogo/conocimiento es configuración del negocio, no tarea diaria de un lead puntual).
2. **Scope V1 acotado:** solo `appliesToAll` + `productIds` (ref real a `Product`) + `channelIds` (ref real a `WhatsAppChannel`). `serviceIds`/`locationIds`/`customerSegments` **no se incluyen en el schema** — no quedan como campos reservados sin uso (evita un campo nullable que nadie puede poblar con sentido); se agregan el día que exista un modelo real de Servicio/Ubicación que referenciar.
3. **Auditoría de uso:** `logger.info()` estructurado (mismo patrón que `PRODUCT_IMPORT_STARTED/COMPLETED`) — sin colección Mongo dedicada para V1. Eventos a loguear: `POLICY_SEARCH`, `FAQ_SEARCH`, `KNOWLEDGE_SEARCH_MISS`, `KNOWLEDGE_CONFLICT_DETECTED`, `KNOWLEDGE_HANDOFF_TRIGGERED`.
4. **FAQs duplicadas por normalización:** **no** es error de validación — se permite, y el retrieval desambigua por `priority` (mayor gana). Consecuencia directa en el modelo: `{business, normalizedQuestion}` es un índice normal (para el lookup), **no** `unique`.
5. **Orden de PRs:** plan final abajo (sección 7) — 10 PRs, organizados como Etapas 2-11 (Etapa 1 = esta auditoría, ya hecha), mismo criterio que Product Intelligence: cada Etapa es 1 PR chico y reversible, con su propia suite de tests, mergeado y aprobado antes de arrancar el siguiente.

---

## 7. Implementation Plan final por Etapas/PRs

Mismo protocolo que Product Intelligence: implemento → corro suite completa → pusheo → paso el diff → espero aprobación → recién ahí la siguiente etapa. Ningún PR empieza sin que el anterior esté mergeado.

**Decisión de estructura de archivos:** un solo módulo `src/modules/business-knowledge/` (sigue la sugerencia de la Spec §45) con `policy.*`/`faq.*` como archivos separados dentro (CRUD independiente, alineado con el RBAC separado de la decisión #1) y un `knowledgeRetrieval.service.js` **unificado** (busca en las 2 colecciones a la vez — es el punto de la Spec §12: una sola tool/contrato que devuelve `{policies, faqs, conflictDetected, needsClarification}`).

| Etapa | Contenido | Se apoya en (reutiliza) |
|---|---|---|
| **1 — Auditoría** ✅ | Este documento. | — |
| **2 — Modelos + validación + índices** | `business-knowledge/policy.model.js` + `faq.model.js`. `business` (no `tenantId`); Policy: `{business,code}` único; FAQ: `{business,normalizedQuestion}` índice normal (no único, decisión #4); índice de texto español en ambos; `status` enum `draft/active/archived`; vigencia (`effectiveFrom`/`effectiveUntil`); `scope` acotado (decisión #2); invariante `effectiveUntil > effectiveFrom` vía `pre('validate')`; invariante `responseMode:'handoff' ⇒ handoffReason` obligatorio. Solo modelos + tests de modelo. | `product.model.js` como plantilla exacta de forma |
| **3 — Service layer + retrieval con hard filters** | `policy.service.js` + `faq.service.js` (CRUD: crear/obtener/listar/actualizar/archivar cada uno) + `knowledgeRetrieval.service.js` (`buscarConocimiento(businessId, query, {productIds, channelId})`, filtro tenant+status+vigencia ANTES de cualquier ranking; sin precedencia/conflicto todavía — orden simple por prioridad). Validación de que `productIds`/`channelIds` del scope pertenecen al mismo `business` (capa de service, no schema — mismo criterio que `crearLead()` valida `assignedTo`). | `product.service.js` como plantilla de forma; `lead.search.js`/`$text` español de `Product` como plantilla de búsqueda |
| **4 — Precedencia y resolución de conflictos** | Ranking en `knowledgeRetrieval.service.js`: especificidad de scope (con `productIds` > `appliesToAll`) + prioridad + vigencia. Precedencia Policy específica > Policy general > FAQ vinculada > FAQ independiente. Desambiguación de FAQs duplicadas por prioridad (decisión #4). Detección de conflicto (Policy activa contradice FAQ → gana Policy, se marca `conflictDetected`). Pieza genuinamente nueva, sin plantilla directa. | Ninguno directo — nuevo, testeado con TC-03/TC-04/TC-05/TC-06/TC-07/TC-08/TC-10/TC-12/TC-15 |
| **5 — CRUD API + RBAC** | `policy.validator/controller/routes.js` (`/api/v1/policies`), `faq.validator/controller/routes.js` (`/api/v1/faqs`), 8 permisos nuevos en `constants.js`/`roles.seed.js` (decisión #1), montaje en `app.js`. | `product.validator/controller/routes.js` como plantilla exacta |
| **6 — Tool del agente + integración en el prompt** | `search_business_knowledge` en `ai/tools/index.js` (TOOL_SCHEMAS+TOOL_EXECUTORS), llama a `knowledgeRetrieval.service.js` con `context.business._id` (nunca desde `args`). `BUSINESS_KNOWLEDGE_GUIDANCE` en `buildSystemPrompt()` (regla anti-alucinación §32, siempre presente). **Sin memoria conversacional nueva** — `Conversation.activeProduct` (ya existente) ya cubre "de qué producto se venía hablando", que es exactamente el contexto que Policy/FAQ scoped a producto necesita (ej. Caso D de la Spec). | Etapas 6/7 de Product Intelligence, patrón idéntico; `activeProduct` reusado tal cual, sin extenderlo |
| **7 — Fallback + handoff explícito** | El resultado de la tool ya incluye `action.responseMode`/`handoffReason` cuando la Policy matcheada lo pide — instrucción en el prompt: "si `responseMode:'handoff'`, invocá `escalate_to_human` con ese motivo" (tool YA existente, PR33 — el modelo la llama en la misma ronda vía el loop multi-tool ya soportado). Probablemente sin código nuevo más allá de la instrucción de prompt + pasar el campo tal cual en el resultado de la tool. | `escalate_to_human` (ya existente); loop multi-ronda ya existente |
| **8 — Interoperabilidad con Product Intelligence (consultas mixtas)** | Tests del caso TC-11 real (`search_products` + `search_business_knowledge` en el mismo turno) — sin cambios de código si las Etapas 6/7 quedaron bien diseñadas; si aparece fricción real, se ajusta acá, acotado. | Loop multi-ronda ya existente |
| **9 — Importación manual con preview** | `policyImport.service.js` (CSV/XLSX, preview→confirm, upsert por `{business,code}` — igual que `productImport.service.js`) + `faqImport.service.js` (mismo flujo, pero **siempre crea**, nunca upsert — no hay clave natural única para FAQ, decisión #4; si el usuario quiere actualizar una FAQ existente vía import, queda fuera de alcance V1, se edita a mano). | `productImport.service.js` como plantilla exacta (Policy); asimetría documentada para FAQ |
| **10 — Tests de integración multi-tenant end-to-end** | Mismo patrón que la Etapa 9 de Product Intelligence: 2 negocios, mismo código/pregunta, contenido distinto, `generateReply()` real de punta a punta, cero cruce. | Etapa 9 de Product Intelligence como plantilla exacta |
| **11 — Panel `/business` (gestión manual)** | Bloque "Políticas y preguntas frecuentes" en el acordeón de `/business` (mismo patrón que `ProductCatalogSection.tsx`): resumen, botón gestionar, import CSV/XLSX. | `ProductCatalogSection.tsx`/`ImportProductsForm.tsx` como plantilla exacta |

**Por qué la importación (Etapa 9) va después del CRUD+tool+fallback (Etapas 5-8):** mismo criterio que Product Intelligence — validar el agente contra datos cargados a mano primero (superficie de riesgo más chica), construir el importador después.

---

## 8. Lo que NO se toca (confirmado explícitamente)

- `product.*`, `lead.*`, `pipeline.*`, `automation.*` — cero cambios.
- `ai.service.js#generateReply()` — solo se le agrega contenido a `buildSystemPrompt()` y una tool nueva al array `TOOL_SCHEMAS`; el loop, `construirVentanaDeMensajes()`, `selectModel()` quedan intactos.
- `DefaultAgentRuntime`/`agentRuntime.interface.js`/Workers/Gateway — cero cambios, confirmado que no hace falta tocarlos (sección 3.4).
- Ninguna dependencia nueva (sin vector DB, sin event bus, sin ORM nuevo, sin auth paralelo) — consistente con la instrucción explícita de la Spec (§43) y del usuario.

---

## 9. Estado

Plan aprobado por el usuario el 11/sep/2026 (las 5 decisiones de la sección 6 + el plan de la sección 7). Arranca la implementación con la **Etapa 2 (modelos)**, mismo protocolo de siempre: implemento → corro suite completa → pusheo → paso el diff → espero revisión antes de la siguiente etapa.
