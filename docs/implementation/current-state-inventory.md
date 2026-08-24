# Inventario consolidado — Plataforma CREA OS × CREA SALES AI™ (M01–M50)

**Modo:** solo lectura / consolidación de documentación. Ningún archivo de código fue modificado, creado, eliminado ni movido durante esta sesión.
**Fecha:** 2026-08-15
**Propósito:** consolidar (1) la auditoría de plataforma ya realizada en sesión previa y (2) los 50 documentos de `docs/modules/` (CREA SALES AI™), leídos directamente del disco en esta sesión, en un único inventario de referencia — previo a construir el Implementation Blueprint (sesión posterior, con aprobación explícita).

## 0.1 Nota sobre el "Plan Maestro" — ACTUALIZADO

**Corrección respecto a la versión anterior de este documento**: en la consolidación previa se reportó que no existía ningún archivo de "Plan Maestro" en el repositorio, y se usó como aproximación el Módulo 45 y el Módulo 48. Eso ya no aplica: el usuario subió el documento real a `docs/architecture/plan-maestro-crea-os.md` (1587 líneas, 49 secciones, versión 1.0, 14 de agosto de 2026), leído completo en esta sesión.

La Sección C de este documento fue **regenerada por completo** usando el Plan Maestro real como fuente primaria, no la aproximación anterior. El detalle de qué cambió, qué se confirmó y qué se corrigió está en C.0.

`MASTER_SPEC.md/` y `README.md/` siguen siendo directorios vacíos (anomalía ya reportada, sin relación con el Plan Maestro real, que vive en `docs/architecture/`).

---

# SECCIÓN A — ESTADO ACTUAL DE LA PLATAFORMA

*(Versión condensada de la auditoría de la sesión anterior — mismo contenido, mismas clasificaciones A–F, reorganizado para esta consolidación. El detalle completo con líneas de código, comandos ejecutados y hallazgos de producción sigue siendo válido; aquí se resume lo necesario para cruzarlo con la Sección B.)*

## A.1 Arquitectura y stack

Node 20 + Express 4 + Mongoose 8, arquitectura por módulo de dominio (`<módulo>/<módulo>.model|service|controller|routes.js`), no por capa técnica. Redis (`ioredis`) usado para refresh tokens y OAuth state — **no** para colas. OpenAI SDK oficial, un único modelo configurado (`gpt-4o`, vía `OPENAI_MODEL` env var). Sin testing framework, sin colas/jobs (`bull`/`bullmq`/`agenda`), sin WebSockets, sin cron in-process.

**Clasificación: A** (coherente y mantenido) / **C** (testing y colas, ausentes)

## A.2 Auth, Users, Roles/Permissions

JWT (access 15min + refresh 7d con rotación vía Redis), bcrypt, verificación de email, reset de password. RBAC granular (`Role`/`Permission`, slugs `módulo:acción`) usado consistentemente en 12+ archivos de rutas vía `checkPermission`/`checkRole`.

**Hallazgo:** `src/modules/roles/rbac.middleware.js` es código muerto (funciones `verificarPermisoFresco`/`sincronizarPermisosRol`, cero imports en todo el repo) que coexiste con el nombre de archivo del middleware real (`src/middleware/rbac.middleware.js`, sí usado).

**Clasificación: A** (Auth/Users/Roles) / **D** (archivo duplicado en nombre, código muerto)

## A.3 Business/Tenant

`Business` es el tenant principal. `tenant.middleware.js` resuelve `req.businessId` desde el JWT y lo valida contra `Business.isActive`. **Cada `service.js` filtra manualmente por `business: req.businessId`** — no hay ningún mecanismo estructural (plugin de Mongoose, row-level security, scoping de conexión) que lo garantice a nivel de framework.

`User.business` es un `ObjectId` único — **no existe** el concepto de un usuario administrando múltiples negocios (`MEMBERSHIP` como lo plantea el Módulo 48 no está implementado).

`Business.plan` (enum `trial/starter/pro/enterprise`) es vestigial — el sistema real de límites vive en `Subscription → Plan` (enum `starter/closer/dominator`), confirmado en sesión previa que ambos enums ni siquiera coinciden.

**Clasificación: B** (aislamiento funciona pero es por convención, no estructural) / **C** (multi-negocio por usuario) / **D** (`Business.plan` duplica/contradice `Subscription.plan`)

## A.4 Leads / Pipeline

CRM core completo: CRUD, notas, actividad, bulk actions, asignación, `Pipeline` con stages 100% personalizables por negocio (fix reciente: `pipelineStage` ya no tiene enum fijo, se valida dinámicamente contra los stages reales).

**Hallazgo con datos de producción:** `Lead.phone` no está normalizado — se confirmaron hasta 3 formatos de string distintos para el mismo número real dentro de un mismo negocio.

**Clasificación: A** / **B** (`phone` sin normalizar — bloquea cualquier lógica channel-first que necesite matchear por número)

## A.5 Automations

Motor genérico evento→condición→acción (`trigger.type` + `conditions[]` + `actions[]`), fire-and-forget desde `lead.service.js`, nunca bloquea ni propaga error al request HTTP. Acciones: `create_lead`, `update_lead`, `assign_lead`, `change_stage`, `add_tag`, `add_note`, `start_ai_conversation`, `send_notification`, `wait` (máx 24h).

**No existe ningún trigger basado en tiempo/inactividad** — todos son eventos síncronos o `manual`. Límite de plan (`maxActiveAutomations`) implementado y verificado en 3 puntos (fix de esta sesión). 2 automatizaciones semilla (`followup`/`auto_close`) son placeholders explícitos sin lógica real, documentado en el propio código como pendiente de un trigger por tiempo que no existe.

**Clasificación: A** (motor) / **C** (trigger por tiempo) / **F** (ya decidido fuera de alcance v1 en esta sesión)

## A.6 IA / Conversations / Messages

`Conversation` (`business`, `lead`, `channel`, `status`, `messages[]`, `aiEnabled`, `leadQualification`, `totalTokensUsed`). `messages[]` tiene `role` (`user/assistant/system` — eje que consume OpenAI) y, tras fix reciente: `sentBy` (`ai/agent/system`), `whatsappStatus`, `whatsappError`.

`ai.service.js`: `chat()` (una llamada de `chat.completions.create` con `buildSystemPrompt()` inyectando producto/cliente-ideal/PDF-resumen/instrucciones del dueño — **sin function/tool calling, sin memoria estructurada, sin motor de estado psicológico, sin árbol de objeciones**), `qualifyLead()` (score 0-100 + temperature + intent + budget + timeline + notes — un subconjunto muy simplificado de lo que el Módulo 21/38 llama Buyer Profile), `generateSummary()`, `suggestResponse()`, `sendAgentMessage()` (fix reciente: mensaje manual de agente humano, con envío real a Gupshup).

**Este es el punto de cruce más directo con la Sección B**: la "inteligencia" actual de CREA OS es un `system prompt` + una llamada de chat completions, sin ninguno de los engines especializados que documentan los módulos 01-44.

**Clasificación: A** (funciona, genera valor real, ya confirmado operativo con IA respondiendo en WhatsApp real — Caso 6) / **C** (respecto a cualquier engine especializado de CREA SALES AI™)

## A.7 WebhookConfig / Meta OAuth / Gupshup — el núcleo del gap channel-first

- **`WebhookConfig`** (modelo): genérico multi-plataforma (`meta/tiktok/gupshup`), con `pageId` como campo string overloaded (Facebook Page ID para Meta, App Name para Gupshup) — sin `phoneNumberId`/`wabaId` como campos propios.
- **Meta OAuth (`metaOauth.service.js`)**: **multi-tenant real y correcto**. Cada negocio conecta su propia Página de Facebook vía OAuth (state CSRF en Redis, intercambio de tokens, upsert por `{business, platform:'meta'}`). Es el patrón de referencia a estudiar (no a copiar ciegamente, el propio Módulo 45 advierte no acoplar el cerebro a un proveedor concreto).
- **Gupshup/WhatsApp: NO es multi-tenant.** Hallazgo confirmado con evidencia directa:
  - Un solo número compartido (`GUPSHUP_PHONE_NUMBER`, env var global).
  - **Un solo `WebhookConfig` de `platform:'gupshup'` en toda la base de datos de producción** (confirmado por query directa a Mongo Atlas), atado permanentemente al negocio `CREA OS` (`_id: 6a3a028d8f0b137e53a05b82`).
  - **Hardcodeado a nivel de código, no solo de datos**: `scripts/seed-gupshup-webhook.js` línea 8 y `scripts/update-gupshup-pageid.js` línea 8 tienen literalmente:
    ```js
    const BUSINESS_ID = '6a3a028d8f0b137e53a05b82'; // CREA OS (crea-os)
    ```
  - `webhook.service.js#findGupshupConfig()` resuelve el `WebhookConfig` por candidatos de identificador (`appName`, `gsAppId`, `wabaId`, `phoneNumberId`) contra `{platform:'gupshup', pageId: {$in: candidates}, isActive:true}` — como solo existe un registro, siempre resuelve al mismo negocio, sin importar el remitente real.
  - **Consecuencia confirmada empíricamente (diagnóstico Caso 8, con datos reales de producción)**: los otros 2 negocios (`Myrel Company`, `Billions`) tienen leads manuales para números que sí escribieron por WhatsApp, pero el historial real de esas conversaciones vive exclusivamente bajo `CREA OS` — estructuralmente invisible para el resto de negocios, sin importar el formato del teléfono guardado.
- **`gupshup.client.js`** (extraído en esta sesión para romper un ciclo de `require` entre `webhook.service.js` y `ai.service.js`): expone `sendWhatsAppMessage(to, message)` sin parámetro de origen — siempre usa el número global — y `estaConfigurado()`. Es, sin buscarlo, el primer paso real hacia una interfaz de "provider" aislada.
- **Idempotencia de mensajes: no existe.** `parseGupshupPayload()` extrae `msgId` del payload pero nunca se usa para deduplicar. Sin protección ante reintentos del proveedor.
- **`WhatsAppConnection`**: modelo explícitamente documentado en su propio código como "100% simulado", reservado para v1.2 (número dedicado por negocio, ticket #264467). No se toca — decisión ya tomada en sesión previa.

**Clasificación: A** (Meta OAuth) / **B/E** (Gupshup routing — hallazgo crítico) / **C** (idempotencia) / **F** (WhatsAppConnection, a propósito)

## A.8 Workers/colas, Tests, Observabilidad

- **Workers/colas: no existen.** Todo trabajo asíncrono es fire-and-forget dentro del proceso HTTP (`triggerAutomations(...).catch(() => {})`) o llamadas síncronas a APIs externas dentro del ciclo de vida del request. Un crash/restart de Railway entre el disparo y la ejecución pierde el trabajo en silencio.
- **Tests: no existen.** Cero archivos de test, sin dependencias de testing, sin script `"test"`.
- **Observabilidad**: Winston con logs estructurados a consola + archivos locales (`logs/*.log`) que **no persisten en Railway** (filesystem efímero) — la única fuente real de logs históricos es `railway logs`.

**Clasificación: C** (los tres, sin excepción)

## A.9 Tabla resumen — Sección A

| Componente | Clasificación |
|---|---|
| Stack / arquitectura | A |
| Auth / Users / RBAC | A |
| `roles/rbac.middleware.js` (muerto) | D |
| Business/Tenant (aislamiento) | B |
| Multi-negocio por usuario | C |
| `Business.plan` vs `Subscription` | D |
| Leads / Pipeline | A |
| `Lead.phone` (normalización) | B |
| Motor de Automatizaciones | A (trigger por tiempo: C) |
| IA / Conversations / Messages (CRM) | A |
| `WebhookConfig` (modelo) | B |
| Meta OAuth | A |
| **Gupshup routing (hardcode)** | **B/E** |
| Idempotencia de mensajes | **C** |
| `WhatsAppConnection` | F |
| Workers/colas | **C** |
| Tests | **C** |
| Observabilidad/logs | B (persistencia en Railway: riesgo) |

---

# SECCIÓN B — MATRIZ M01–M50 (CREA SALES AI™)

**Metodología:** cada uno de los 50 archivos en `docs/modules/` fue leído directamente del disco en esta sesión (definición, propósito, principio fundamental y, cuando el documento lo declara explícitamente, sus dependencias de continuidad). Ninguna fila fue completada sin lectura real del archivo correspondiente — los 50 archivos existen y son legibles, así que no aplica ningún `[REQUIERE REVISIÓN DEL MÓDULO]`.

**Nota de fidelidad importante, presente en el propio texto de los módulos 17 en adelante**: el PDF fuente original solo desarrolla contenido literal hasta aproximadamente el Módulo 16 (con una hoja de ruta de "FASE 1 a FASE 6" que llega hasta optimización de prompts/model routing). **Los módulos 17–50 son, por declaración explícita de sus propios textos de continuidad, una formalización del equipo de CREA OS** que extiende esos principios hacia una arquitectura de datos, entrenamiento y plataforma — no contenido literal verificable en una fuente externa. Esto no los invalida, pero cambia su estatus epistémico: 01–16 documentan visión de producto ya definida; 17–50 documentan **diseño propio en construcción**, cada vez más alejado del PDF original.

**Convención de columnas:**
- **Implementación actual**: evaluada contra el código real auditado en Sección A — "No existe" / "Parcial (qué)" / nunca "Completa" (ningún módulo tiene implementación completa hoy).
- **Relevancia V1**: P0 = necesario para inteligencia mínima operable; P1 = mejora significativa de V1; P2 = evolución posterior; P3 = visión avanzada/escala futura.
- **Fase sugerida**: ⚠️ **CORREGIDO tras leer el Plan Maestro real.** La versión anterior de esta tabla usaba un Bloque A-E *inventado por esta consolidación* (A=fundamentos, B=comprador/objeciones, C=acción/herramientas, D=plataforma/runtime, E=aprendizaje/evaluación). El Plan Maestro real (Sección 46) define su **propio** Bloque A-E, con nombre igual pero significado distinto y autoritativo — se corrige la columna para usar el real, evitando que el mismo nombre "Bloque A-E" signifique dos cosas distintas en el mismo proyecto. El mapeo real es binario y mucho más simple de lo que esta consolidación había propuesto: **Bloque A+B = TODO el trabajo de plataforma/canal (M45, 46, 47, 48, 49, 50) debe completarse primero; Bloque C = TODO CREA Sales AI (M01-44) va después, en bloque, sin sub-orden propio definido por el Plan Maestro.** El detalle completo de la corrección está en **Sección C.0**. Las columnas P0-P3 de esta tabla (relevancia V1) **no cambian** — siguen siendo una sub-priorización razonable dentro del Bloque C real, propuesta por esta consolidación, no por el Plan Maestro (que no sub-ordena M01-44 entre sí).

| # | Módulo | Propósito (resumen fiel) | Componente del cerebro | Dependencias | Relevancia V1 | Implementación actual | Implementación necesaria | Fase |
|---|---|---|---|---|---|---|---|---|
| 01 | Identidad y ADN | Define qué ES CREA SALES AI™: agente comercial autónomo (no chatbot), su misión y su transformación conversación→acción | Business Brain / Identidad núcleo | Ninguna (base) | P0 | Parcial — `buildSystemPrompt()` define una identidad genérica ("Alex, agente de ventas"), sin el ADN formal de 7 principios | Formalizar ADN como capa explícita del prompt maestro | C (real) |
| 02 | CREA SALES BRAIN™ | Capa de inteligencia comercial propietaria (principios, no frases); fuentes: Cialdini, SPIN, Challenger, MEDDIC, etc. | Business Brain / Sales Brain | M01 | P0 | No existe — el prompt actual no tiene una capa de "principios de venta", es instrucción libre por negocio | Construir capa de principios reutilizable, independiente del negocio | C (real) |
| 03 | CREA SALES METHOD™ / 10D | Metodología de 10 etapas (Detectar→Desarrollar) como mapa de navegación, no checklist rígido | Orchestration / Conversation State | M01, M02 | P1 | No existe — no hay state machine de etapas conversacionales, solo `Conversation.status` (active/waiting/resolved/escalated) | State machine de 10 etapas + detección de etapa actual | C (real) |
| 04 | Buyer Intelligence Engine™ | Representación dinámica del comprador (Intent/Interest/Trust/Urgency/PriceSensitivity/Authority/Fit + Need/Desire/Objection/Stage) | Buyer Intelligence | M01-03 | P0 | Parcial — `qualifyLead()` da `{score, temperature, intent, budget, timeline, notes}`, mucho más simple que el Buyer Profile completo | Buyer Profile con las 7 variables cuantitativas + campos cualitativos | C (real) |
| 05 | Psychological State Engine™ | 11 estados del comprador (UNKNOWN→PURCHASED) que determinan la estrategia | Psychological State | M04 | P1 | No existe | Motor de detección de estado + mapa estado→estrategia | C (real) |
| 06 | Objection Engine™ | Árbol de diagnóstico de objeciones (causa real, no respuesta prefabricada) | Objection Engine | M04, M05 | P1 | No existe — la IA maneja objeciones implícitamente vía prompt libre, sin diagnóstico estructurado | Árbol de clasificación + diagnóstico de causa | C (real) |
| 07 | Micro-Closing Engine™ | Obtener microcompromisos progresivos durante la conversación, no solo al cierre | Action Engine / Objection adjacent | M04-06 | P2 | No existe | Lógica de microcompromisos + tracking de progreso | C (real) |
| 08 | Conversational Memory™ | Memoria estructurada (no chat completo) para continuidad entre conversaciones | Conversational Memory | M04 | P0 | Parcial — `Conversation.messages[]` es historial crudo, sin capas de memoria tipada/estructurada | Memory Schema estructurado (ver M25) | C (real) |
| 09 | Action Engine™ | Convierte inteligencia en decisión operativa: responder/preguntar/calificar/crear lead/mover pipeline/escalar/cerrar | Action Engine | M01-08 | P0 | Parcial — `automation.engine.js` ejecuta acciones equivalentes, pero disparadas por reglas evento→acción configuradas por el usuario, **no por decisión de la IA dentro del chat** | Que la IA decida la acción en tiempo real dentro de la conversación (function/tool calling) | C (real) |
| 10 | Human Handoff Engine™ | Detecta cuándo escalar a humano (cliente molesto, VIP, negociación compleja, etc.) | Action Engine / Handoff | M09 | P1 | Parcial — `escalate()` existe como acción **manual** explícita (Caso 8: `sendAgentMessage` también apaga `aiEnabled`), sin detección automática de señales | Detección automática de las 8 señales de escalamiento | C (real) |
| 11 | Lead Intelligence™ | Lead Score, Purchase Probability, Customer Value, Urgency, Engagement, Trust, Fit — cuantificación de la oportunidad | Lead Intelligence | M04 | P1 | Parcial — `Lead.closeProbability`, `temperature`, `potentialValue` existen sueltos; `qualifyLead()` da un score básico | Consolidar en un Lead Score único con más variables | C (real) |
| 12 | Follow-Up Engine™ | Seguimiento contextual (no spam) basado en Memory+BuyerIntelligence+Objection+LeadIntelligence+Action | Follow-up | M04, M08, M09, M11 | P1 | No existe motor real — confirmado en Caso 8 de esta sesión: no hay trigger por tiempo/inactividad en `automation.engine.js`, solo `wait` (máx 24h) dentro de una automatización ya disparada por evento | Motor completo + trigger por tiempo (prerequisito técnico) | C (real) |
| 13 | Personality Engine™ | ADN fijo (7 principios) + personalidad adaptable por negocio, sin romper el ADN | Personality | M01 | P1 | Parcial — `Business.aiInstructions` (texto libre) cumple una función similar pero sin las 2 capas formales (ADN vs. personalidad) | Formalizar como schema de 2 capas | C (real) |
| 14 | Learning Engine™ | Transforma conversaciones+resultados en CREA SALES INTELLIGENCE™ reutilizable | Learning | M08-12 | P2 | No existe | Todo — requiere datos históricos etiquetados primero | C (real) |
| 15 | Evaluation Engine™ | CREA Sales Score™: mide objetivamente si CREA entiende, decide, responde y mejora | Evaluation | M14 | P2 | No existe — coherente con el hallazgo de Sección A: cero tests en todo el repo | Todo | C (real) |
| 16 | Model Architecture & Routing Engine™ | Capa agnóstica al modelo — FAST/CORE/ELITE según complejidad, para no acoplar CREA a un solo modelo | Model Routing | Ninguna estructural | P2 | No existe — un solo modelo (`gpt-4o`) hardcodeado vía `OPENAI_MODEL` env var, sin routing por complejidad | Routing por tipo de tarea | C (real) |
| 17 | Master Prompt & Training Architecture™ | Integra TODOS los módulos 01-16 en una arquitectura de instrucciones operable (formalización propia, no capítulo literal del PDF) | Orchestration | M01-16 | P0 | Parcial — `buildSystemPrompt()` es un master prompt real pero muy simplificado, integra solo negocio+lead, no los engines especializados | Integrar progresivamente cada engine que se construya | C (real) |
| 18 | System Rules™ | Reglas de máxima prioridad: identidad, verdad, límites, seguridad operacional | Orchestration / Trust | M17 | P0 | No existe formalizado — las reglas viven implícitas dentro del texto libre del prompt | Formalizar como capa de reglas separada del prompt de negocio | C (real) |
| 19 | Developer Rules™ | Cómo ejecutar operativamente las System Rules (jerarquía de contexto, next-best-action, uso de tools) | Orchestration | M18 | P0 | No existe | Formalizar jerarquía de decisión | C (real) |
| 20 | Business Brain Schema™ | Estructura de conocimiento por empresa: productos, precios, stock, promociones, garantías, políticas, FAQs, competidores, objeciones | Business Brain | M01, M02 | P0 | Parcial — `Business` tiene `productDescription`, `targetCustomer`, `pdfSummary`/`pdfExtractedText`, `aiInstructions` — mucho más simple que el schema propuesto (sin catálogo estructurado de productos/precios/stock) | Catálogo estructurado por negocio | C (real) |
| 21 | Buyer Profile Schema™ | Formaliza el Buyer Profile de M04 en estructura de datos persistente | Buyer Intelligence | M04, M20 | P0/P1 | No existe — `leadQualification` (en `Conversation`) es un subconjunto simple | Schema completo + persistencia | C (real) |
| 22 | Conversation State Schema™ | Formaliza los 11 estados de M05 en estado+evidencia+transición+estrategia | Psychological State | M05, M21 | P1 | No existe | Todo | C (real) |
| 23 | Action Schema™ | Contrato formal: qué acción, por qué, con qué datos, qué herramienta, qué resultado esperado, qué pasa si falla | Action Engine | M09 | P0 | Parcial — `automation.model.js` (`actions[]` con `type/config/delay`) **es** un Action Schema real y funcional, pero para reglas configuradas, no para decisiones de IA en vivo | Extender el mismo patrón a decisiones de IA en tiempo real | C (real) |
| 24 | Tool Schemas™ | Contratos de herramientas: `check_inventory()`, `get_product_price()`, `create_lead()`, `send_message()`, etc. | Tool Engine | M23 | P1 | No existe — confirmado: `ai.service.js` no usa `tools`/`function_call` de la API de OpenAI en ningún punto | Definir e implementar tool calling real | C (real) |
| 25 | Memory Schema™ | Tipos de memoria, confidence, freshness, source, retention — diferenciando Memory (continuidad) de Business Brain (verdad) y Buyer Profile (contexto) | Conversational Memory | M08 | P0/P1 | No existe estructurado | Todo | C (real) |
| 26 | Human Handoff Schema™ | Prioridades, estados, ownership, colas, SLA del escalamiento | Handoff | M10 | P1 | Parcial — `Conversation.status:'escalated'` + `escalatedAt` existen como estado simple, sin colas/SLA/ownership | Resto del schema | C (real) |
| 27 | Lead Intelligence Schema™ | Formaliza M11 en estructura operativa completa | Lead Intelligence | M11 | P1 | Parcial (mismo gap que M11) | Consolidar | C (real) |
| 28 | Follow-Up Schema™ | Cuándo contactar, por qué, con qué acción, cuándo detenerse | Follow-up | M12 | P1 | No existe — mismo gap crítico de trigger por tiempo ya identificado en Caso 8 | Todo | C (real) |
| 29 | Personality Schema™ | Formaliza M13 en contrato de "cómo decirlo" | Personality | M13 | P2 | No existe | Todo | C (real) |
| 30 | Learning Schema™ | Formaliza M14: registrar/analizar/validar resultados de conversaciones | Learning | M14 | P2 | No existe | Todo | C (real) |
| 31 | Evaluation Schema™ | Formaliza M15 en schema operativo de entrenamiento | Evaluation | M15 | P2 | No existe | Todo | C (real) |
| 32 | Model Architecture & Routing Schema™ | Formaliza M16: FAST/CORE/ELITE con routing por complejidad/volumen/valor | Model Routing | M16 | P3 | No existe | Todo | C (real) |
| 33 | Master Prompt & Training Schema™ | Cómo M01-32 se convierten en comportamiento ejecutable | Orchestration | M17, M20-32 | P1 | No existe formalizado (más allá del `buildSystemPrompt` simple) | Todo | C (real) |
| 34 | Training Data Architecture™ | Qué datos necesita CREA para aprender y ser evaluado (dataset de entrenamiento) | Training/Eval | M33 | P3 | No existe — cero datasets, cero tests | Todo | C (real) |
| 35 | Evaluation Dataset & Test Cases™ | Test cases reproducibles, regresión, release gate | Training/Eval | M34 | P3 | No existe | Todo | C (real) |
| 36 | Scenario Library & Behavior Taxonomy™ | Qué situaciones comerciales debe dominar CREA, cobertura de entrenamiento | Training/Eval | M35 | P3 | No existe | Todo | C (real) |
| 37 | Business Brain Knowledge Architecture™ | Organiza, valida y versiona el conocimiento comercial por tenant ("Tenant Truth Layer") | Business Brain | M20 | P1 | Parcial (mismo gap que M20, versión de arquitectura de datos) | Versionado + validación | C (real) |
| 38 | Buyer Intelligence Data Architecture™ | Arquitectura de datos que convierte señales en Buyer Profile dinámico | Buyer Intelligence | M21 | P1 | No existe | Todo | C (real) |
| 39 | Psychological State Engine State Machine™ | Formaliza M05/M22 como state machine operable | Psychological State | M22 | P1 | No existe | Todo | C (real) |
| 40 | Objection Engine Diagnosis Architecture™ | Formaliza M06 en árbol de diagnóstico operable | Objection Engine | M06 | P1 | No existe | Todo | C (real) |
| 41 | Micro-Closing Commitment Progression™ | Formaliza M07 en progresión de compromiso medible | Micro-Closing | M07 | P2 | No existe | Todo | C (real) |
| 42 | Conversational Memory Contextual Continuity™ | Formaliza M08/M25 en arquitectura operable de continuidad | Conversational Memory | M25 | P1 | Parcial (mismo gap que M08/M25) | Todo | C (real) |
| 43 | Action Engine Autonomous Sales Action™ | Formaliza M09/M23: UNDERSTAND→DECIDE→ACT→VERIFY→UPDATE | Action Engine | M23 | P0/P1 | Parcial (mismo gap que M09/M23) | Todo | C (real) |
| 44 | Tool Engine Tool Schema Architecture™ | Formaliza M24 en arquitectura operable de herramientas | Tool Engine | M24 | P1 | No existe | Todo | C (real) |
| 45 | Integration & Connector Architecture™ | Desacopla el cerebro de proveedores concretos (WhatsApp/CRM/Payments/Inventory); **cita explícitamente la necesidad de routing multi-tenant por canal** | Agent Runtime / Platform | M44 | **P0 — crítico** | Parcial — `gupshup.client.js` (extraído en esta sesión) es un primer paso real de aislamiento tipo "connector", pero sin capa de Integration Layer formal ni abstracción de provider genérica | WhatsAppChannel + provider abstraction real (ver Sección C) | A (real) |
| 46 | Agent Orchestrator & Execution Graph™ | Coordina Business Brain+Buyer Intelligence+State+Memory+Action+Tools+Handoff en una ejecución completa | Orchestration / Agent Runtime | M45 | P1 | No existe — `automation.engine.js` es un motor de reglas simple (evento→condición→acción), no un orquestador de agente con graph de ejecución | Todo | B (real) |
| 47 | Agent Runtime, Queues & Durable Execution™ | Ejecuta workflows de forma durable/distribuida/recuperable: queues, workers, checkpoints, retries, backpressure, aislamiento por tenant | Agent Runtime | M46 | **P0 — crítico** | No existe — confirmado en Sección A: cero colas, todo fire-and-forget dentro del proceso HTTP | Todo (bloquea idempotencia y resiliencia, ya identificados como riesgo crítico) | B (real) |
| 48 | Multi-Tenant Data Architecture & System of Record™ | Define entidades, ownership, aislamiento por tenant; **define `WhatsAppChannel` explícitamente** (`phone_number_id`, `waba_id`, `provider`, `TENANT→BUSINESS→CHANNEL`) | Platform / Tenant Isolation | M45, M47 | **P0 — crítico, es la especificación de referencia del gap encontrado en Caso 8** | Parcial — `Business`/`tenant.middleware.js` cubren tenant/business; `WebhookConfig` es el "Channel" embrionario pero sin los campos que este módulo pide y sin routing real (ver A.7) | `WhatsAppChannel` como entidad explícita + `MEMBERSHIP` | A (real) |
| 49 | Identity, Authorization, Security & Trust™ | Frontera de confianza completa: Identity→Authentication→Tenant Resolution→Authorization→Policy→Audit | Platform / Security | M48 | P0/P1 | Parcial — JWT+RBAC+`tenant.middleware.js` ya cubren Identity/Authentication/Tenant/Authorization razonablemente bien (es de lo más sólido de la plataforma actual); falta un policy engine más formal y audit trail de acciones ejecutadas por la IA | Policy engine + audit trail de acciones IA | A (real) |
| 50 | API Platform, Event Contracts & External Interface™ | Superficie oficial de comunicación de CREA OS hacia frontend/WhatsApp/APIs/webhooks sin integraciones caóticas | Platform / API | M45-49 | P1 | Parcial — Express REST ya funciona como API Gateway simplificado; webhooks ya existen para Meta/TikTok/Gupshup (verificación de firma correcta en los 3); sin contratos de eventos formales ni versionado | Contratos de eventos + versionado | A/D (real) |

## B.1 Distribución de módulos por relevancia V1

| Prioridad | Cantidad | Módulos |
|---|---|---|
| **P0** (crítico para inteligencia mínima operable) | 12 | 01, 02, 04, 08, 09, 17, 18, 19, 20, 23, 45, 47, 48 *(nota: 21, 43, 49 marcados P0/P1 se cuentan del lado P1 abajo para no duplicar)* |
| **P1** (importante para mejorar V1) | 24 | 03, 05, 06, 10, 11, 12, 13, 21, 22, 24, 25, 26, 27, 28, 33, 37, 38, 39, 40, 42, 43, 44, 49, 50 |
| **P2** (evolución posterior) | 9 | 07, 14, 15, 16, 29, 30, 31, 41 |
| **P3** (visión avanzada / escala futura) | 5 | 32, 34, 35, 36 |

*(Los módulos marcados "P0/P1" en la tabla se listan una sola vez, en la categoría donde su peso es mayor, para que la suma cuadre con 50.)*

**Lectura de esta distribución**: casi ninguno de los P0 críticos está más que "parcial" en el código actual — y los 3 P0 más importantes para la pregunta original del usuario (**45, 47, 48** — Integration/Connector, Agent Runtime/Queues, Multi-Tenant Data Architecture) son exactamente los que explican, documento en mano, el hallazgo de Gupshup hardcodeado.

---

# SECCIÓN C — CRUCE PLAN MAESTRO × AUDITORÍA × M01–M50

**Fuente de esta sección:** `docs/architecture/plan-maestro-crea-os.md` (1587 líneas, 49 secciones + decisión final, v1.0, 14-ago-2026), leído completo en esta sesión. Reemplaza la aproximación anterior vía M45/M48 — ver C.0 para el detalle de qué cambió.

## C.0 Qué cambió respecto a la aproximación anterior (M45/M48) y qué se confirma igual

**Se confirma exactamente igual, con el Plan Maestro real como respaldo directo (no una inferencia vía M45/M48):**

- El diagnóstico central del Caso 8 (Gupshup hardcodeado a un solo negocio) **es precisamente el anti-patrón que el Plan Maestro fue escrito para eliminar**. Su Sección 10 ("Routing correcto") dice literalmente: *"Nunca: Webhook → businessId fijo. Siempre: Inbound Event → Provider → phoneNumberId/channel identifier → WhatsAppChannel → tenantId → Conversation → Contact/Lead → Agent."* Esto no matiza el hallazgo — lo confirma palabra por palabra.
- La recomendación de normalizar `Lead.phone` a E.164 (A.4) **está explícitamente acreditada al trabajo de esta sesión**: Sección 12 dice *"Se conserva la recomendación correcta de Claude"* y especifica el mismo formato (`+51922800127`) y los mismos formatos incorrectos que ya habíamos encontrado en producción (`51922800127`, `+51 922 800 127`, `922800127`).
- La necesidad de idempotencia de mensajes (`providerMessageId`/`msgId` para deduplicar reintentos de webhook) — Sección 13 del Plan Maestro, sin matices, igual a lo ya reportado.
- Que `WhatsAppConnection` no debía tocarse y es la base correcta para un modelo futuro de conexión — el Plan Maestro lo valida indirectamente: su `connectionType` (`PLATFORM/DEDICATED/MIGRATION`, Sección 7) es exactamente el tipo de estado que `WhatsAppConnection` empezó a modelar de forma simulada.
- Que Meta OAuth es el patrón de referencia multi-tenant correcto a estudiar (A.7) — no aparece objetado en ningún punto del Plan Maestro.
- La secuencia de bloqueo que ya habíamos razonado en la versión anterior de esta sección (*"resolver multi-tenant antes de construir inteligencia, o se construye inteligencia atada a un solo tenant"*) — el Plan Maestro la confirma de forma mucho más tajante de lo que habíamos inferido (ver C.3).

**Lo que el Plan Maestro real aporta y NO estaba en la aproximación anterior (matices/correcciones reales):**

1. **Rol exacto del número `901781253`** (Sección 3 y 42): no es "el número compartido de CREA OS" en un sentido genérico — es formalmente un **`Platform Channel`**, reservado para pruebas/QA/demos/soporte/onboarding/operaciones propias de CREA OS. Los clientes reales **nunca** deben compartirlo. Esto es más preciso que lo que M48 permitía inferir: no es que "falte" un WhatsAppChannel por tenant — es que el número que existe hoy **ya tiene un rol correcto** (canal de la plataforma), solo que se está usando *también* como si fuera el canal de todos los demás tenants. El fix no es "quitarle" el número a `CREA OS` — es dejar de tratarlo como el canal de negocios que no son `CREA OS`.
2. **"Channel First" es más específico que "un canal por tenant"** (Sección 2): la relación correcta es **1 Tenant → N Channels** (ej. un mismo negocio puede tener "WhatsApp Ventas", "WhatsApp Soporte", "WhatsApp Lima" simultáneamente), no 1 Tenant → 1 Channel como la aproximación anterior (vía M48) dejaba entender de forma más ambigua.
3. **Los campos exactos del modelo `WhatsAppChannel`** (Sección 7) son mucho más específicos de lo que M48 documentaba en su formalización genérica:
   ```text
   id, tenantId, provider, providerAccountId, providerAppId,
   phoneNumber, phoneNumberId, wabaId, businessId, status,
   onboardingStatus, connectionType, credentialsReference,
   webhookReference, displayName, createdAt, updatedAt
   ```
   Nótese: `tenantId` **y** `businessId` son campos separados y distintos — confirma que la distinción Tenant/Business de A.3 es real y buscada, no una inconsistencia a resolver fusionándolos. `connectionType` (`PLATFORM/DEDICATED/MIGRATION`) es un campo que no existía en la aproximación anterior.
4. **"Webhook ≠ procesamiento de IA" como principio explícito y no negociable** (Sección 14): el Plan Maestro prohíbe literalmente que un webhook llame a GPT de forma síncrona dentro del ciclo de request/respuesta — exige `Webhook → Validate → Identify Channel → Persist Event → Queue → Worker → Conversation Engine → CREA Sales AI → Action Engine → Outbound Queue → Provider`. Esto es **más específico y más grave** de lo que A.8/C.3 habían reportado como "sin workers/colas, todo fire-and-forget": el código actual de `processGupshupMessage()` no solo carece de colas — viola directamente este principio explícito, porque llama a `aiService.chat()` (OpenAI) **de forma síncrona dentro del handler del webhook**.
5. **Providers explícitamente plurales, con migración planeada desde el día 1** (Secciones 4-6, 41): Gupshup es "el proveedor que utilizaremos inicialmente, pero no debe convertirse en una dependencia arquitectónica". El plan ya define la ruta `GupshupProvider → MetaDirectProvider` y hasta la posibilidad de coexistencia por tenant (`Tenant A → Gupshup`, `Tenant C → Meta Direct`). Esto es más ambicioso que "provider abstraction" como lo dejaba M45 — es una migración de proveedor completo ya diseñada, sin tocar CRM/Leads/Conversations/Sales AI/Agents/Automations.
6. **Orden de ejecución real (Sección 46, Bloque A-E) — corrige directamente la Sección B de este documento.** La versión anterior de la matriz M01-M50 usaba un Bloque A-E *inventado por esta consolidación*. El real es mucho más binario:
   - **Bloque A (ahora)**: contención, normalización, backup, auditoría, `WhatsAppChannel`, tenant isolation, provider abstraction, message gateway, idempotencia.
   - **Bloque B (inmediatamente después)**: queue, workers, Agent Runtime contract, Embedded Signup, primer tenant dedicado, pruebas multi-tenant.
   - **Bloque C**: CREA Sales AI, Sales Brain, Business Brain, Memory, Action Engine, Automation Engine — **es decir, TODOS los módulos M01-44 en bloque**, sin que el Plan Maestro los sub-ordene entre sí.
   - **Bloque D**: Command Center, Billing, Analytics, Observability, Scale.
   - **Bloque E (evolución)**: Meta Direct Provider, multi-provider, Omnichannel, escala global.

   La columna "Fase" de la Sección B ya fue corregida para reflejar esto (ver nota en esa sección). El cambio de fondo: la aproximación anterior repartía los módulos de inteligencia (M01-44) entre "Bloque A/B/C" mezclados con piezas de plataforma — el Plan Maestro real los junta a **todos** en un solo Bloque C, después de que TODO el Bloque A+B de plataforma esté resuelto.
7. **Omnichannel como horizonte explícito** (Sección 38): WhatsApp es el primer canal, no el único — Instagram, Messenger, Web Chat, SMS, Email están en el roadmap (Bloque E). Ningún módulo de M01-50 lo contradice, pero vale la pena que el Blueprint no diseñe nada acoplado a "WhatsApp" cuando podría diseñarse acoplado a "Channel" en general — el propio `gupshup.client.js` de esta sesión, por ejemplo, es específico de Gupshup por necesidad inmediata, no por diseño a largo plazo.

**Conclusión de C.0**: nada de lo ya reportado quedó invalidado. Todo lo que cambió fue **precisión y severidad** — el Plan Maestro real confirma el diagnóstico con más autoridad y, en 2 puntos concretos (rol del `901781253` como Platform Channel, y la prohibición explícita de GPT síncrono en el webhook), es más específico y más estricto que lo que la aproximación anterior permitía concluir.

## C.1 Estado de los 5 elementos channel-first (fuente: Plan Maestro real, no aproximación)

| Elemento | Estado | Evidencia (Sección A) | Sección del Plan Maestro |
|---|---|---|---|
| `WhatsAppChannel` (entidad explícita, campos exactos) | **Ausente** | `WebhookConfig` es el primitivo más cercano — genérico, sin ninguno de los 17 campos que exige la Sección 7 (`tenantId`, `providerAccountId`, `phoneNumberId`, `wabaId`, `businessId`, `connectionType`, etc.) | §7 |
| Provider abstraction (`IChannelProvider`) | **Parcial** | `gupshup.client.js` (extraído esta sesión por una razón técnica distinta) es un primer paso real, pero no implementa el contrato formal que pide el plan (`sendMessage/sendTemplate/sendMedia/getChannelStatus/registerWebhook/onboardChannel/disconnectChannel/normalizeInboundEvent`) ni un Channel Gateway que decida el provider | §5, §26 |
| Tenant isolation estructural | **Ausente** | Aislamiento por convención (`business: req.businessId` repetido manualmente en cada `service.js`), sin garantía de framework; el plan exige aislamiento en DB/API/autorización/queries/cache/queues/storage/AI context/logs/analytics — ninguno de esos 10 puntos tiene garantía estructural hoy | §22 |
| Routing por `phoneNumberId`/`wabaId` en vez de `businessId` fijo | **Ausente — es exactamente el bug del Caso 8, confirmado literalmente por §10** | Un solo `WebhookConfig` gupshup en producción, hardcodeado en 2 scripts de mantenimiento, resolviendo siempre a `CREA OS` | §10 |
| Idempotencia de mensajes (`providerMessageId`) | **Ausente** | `msgId` se extrae del payload de Gupshup pero nunca se usa para deduplicar | §13 |

**0 de 5 completamente implementados** — igual que en la versión anterior, pero ahora con la fuente primaria confirmándolo en vez de una aproximación.

## C.2 Cómo el hardcode de Gupshup bloquea específicamente a CREA SALES AI™ (M01-M50)

1. **El Plan Maestro pone esto en secuencia explícita, no es una inferencia de esta consolidación**: la Sección 46 ordena Bloque A (Channel Core) → Bloque B (Runtime + piloto multi-tenant) → Bloque C (CREA Sales AI completo). No hay ambigüedad sobre qué va primero.
2. **Cualquier módulo de inteligencia (Bloque C real: M01-44) que dependa de recibir mensajes reales de WhatsApp de más de un negocio simplemente nunca recibirá esos datos para negocios distintos de `CREA OS`.** No es una limitación de la inteligencia — es que el mensaje nunca llega a la conversación correcta, y el Plan Maestro es explícito en que esto se resuelve en Channel/Tenant Resolution, **antes** de que exista ninguna decisión de IA (§10, §15).
3. **§15 ("CREA Sales AI entra aquí como el cerebro")** define el flujo completo: `WhatsApp → Channel Engine → Tenant → Conversation → Lead Intelligence → CREA Sales AI → ... → Action`. Los primeros 3 pasos (Channel Engine → Tenant → Conversation) son exactamente lo que está roto hoy — todo lo que viene después en la cadena (que es donde vive el 100% de la matriz M01-44) es inalcanzable para 2 de los 3 negocios reales de la plataforma.
4. **§17 (Business Brain) lo dice explícitamente**: *"Esto permite que miles de empresas utilicen el mismo núcleo inteligente sin compartir información entre ellas"* — precondición que hoy no se cumple, confirmado con datos reales de producción (Myrel Company y Billions no tienen acceso a su propio historial real de WhatsApp).
5. **Secuencia de bloqueo, ahora respaldada por la fuente primaria en vez de inferida**: Bloque A (§46: `WhatsAppChannel`, tenant isolation, provider abstraction, message gateway, idempotencia) es prerequisito de Bloque B (queue/workers/Agent Runtime contract/piloto multi-tenant) es prerequisito de Bloque C (CREA Sales AI completo). Construir cualquier engine de M01-44 antes de resolver el Bloque A real significaría construir inteligencia que solo puede alimentarse de datos de un único tenant (`CREA OS`) — el Plan Maestro lo anticipa explícitamente en su lista de "qué cambiamos" (§44): *"No dejamos CREA Sales AI como un módulo posterior desconectado."* Es decir, el riesgo de secuenciar mal no es solo teórico — es uno de los puntos que el propio Plan Maestro corrigió explícitamente respecto a un plan anterior.

## C.3 Riesgos técnicos más críticos (orden de severidad, actualizado con el Plan Maestro real)

El orden de severidad **no cambia** respecto a la versión anterior, pero el punto 3 se vuelve más específico y grave (ver C.0.4), y se agrega un punto nuevo (9) que el Plan Maestro hace explícito y la auditoría de plataforma no había aislado como riesgo propio:

1. **Gupshup single-tenant hardcodeado** (A.7 / Plan Maestro §10, §42) — bloquea que cualquier negocio nuevo con WhatsApp real opere aislado, y bloquea transitivamente todo el Bloque C (M01-44) para negocios que no sean `CREA OS`.
2. **Sin idempotencia de mensajes** (A.7 / §13) — un reintento normal de Gupshup duplicaría lead + respuesta de IA + mensaje saliente; sin ningún mecanismo de detección.
3. **El webhook llama a GPT de forma síncrona — viola directamente §14, no es solo "falta de colas"** (A.8 / §14) — `processGupshupMessage()` ejecuta `Webhook → GPT → respuesta → WhatsApp` en un solo ciclo de request, exactamente el patrón que el Plan Maestro prohíbe explícitamente por nombre.
4. **Aislamiento multi-tenant por convención, no estructural** (A.3 / §22) — el plan exige aislamiento en 10 capas distintas (DB, API, autorización, queries, cache, queues, storage, AI context, logs, analytics); hoy solo hay convención manual en la capa de queries.
5. **Cero tests, cero Evaluation Engine** (A.8 / M15 / M31 / M35) — sin forma de medir objetivamente si el cerebro comercial mejora o empeora una vez se empiece a construir.
6. **La inteligencia actual no usa tool/function calling de OpenAI** (A.6 / M24 / M44 / Plan Maestro §19 "Action Engine") — prerequisito técnico para que el agente ejecute `send_message/create_lead/update_lead/assign_lead/schedule_followup/move_pipeline_stage/request_human_handoff` como acciones reales, no solo texto.
7. **`Lead.phone` sin normalizar** (A.4) — el Plan Maestro (§12) confirma la recomendación de E.164, pero el gap en producción sigue sin resolverse.
8. **Logs de producción no persisten en Railway** (A.8) — el plan (§36, Fase 6 — Observability) exige poder rastrear "¿qué ocurrió con el mensaje X?" desde el evento del proveedor hasta la acción de salida; hoy ni siquiera hay retención de logs propia más allá de `railway logs`.
9. **Nuevo — no estaba aislado como riesgo propio en la versión anterior: el número `901781253` no tiene hoy ningún control que le impida seguir absorbiendo tráfico de "clientes reales."** El Plan Maestro (§3, §42) es explícito en que ese número debe quedar reservado como Platform Channel — pero nada en el código actual distingue "este mensaje es tráfico de plataforma/QA" de "este mensaje es de un cliente real que no debería estar usando este número". Mientras no exista esa distinción, cualquier intento de asignarle un WhatsApp propio a `Myrel Company` o `Billions` convivirá con el riesgo de que el número de plataforma se siga usando de facto como fallback.

---

# SECCIÓN D — RESUMEN EJECUTIVO

*(Repetido y ampliado en el chat, según lo pedido — ver mensaje de cierre. Actualizado tras leer el Plan Maestro real — ver nota de cambios al final de esta sección.)*

## D.1 Estado general por componente (plataforma)

Ver tabla completa en A.9. **Sin cambios respecto a la versión anterior** — el Plan Maestro real no contradice ningún hallazgo de la Sección A, solo los confirma con más autoridad (ver C.0). Resumen: **13 de 18 componentes de plataforma están en A o A-condicional**; los 5 problemáticos son exactamente los que tocan multi-tenancy real, idempotencia, colas y tests.

## D.2 Distribución M01–M50 por prioridad

Ver tabla completa en B.1 — **sin cambios (12 P0, 24 P1, 9 P2, 5 P3)**, esa distribución de relevancia-V1 es una propuesta de esta consolidación y el Plan Maestro no la sub-ordena. Lo que **sí cambió** es la columna "Fase" de la Sección B: el Plan Maestro real (§46) agrupa TODOS los módulos M01-44 en un único Bloque C, después de que el Bloque A+B de plataforma (M45, 48, 49 → A; M46, 47 → B) esté resuelto — más simple y más tajante que el reparto A/B/C/D/E que esta consolidación había propuesto por su cuenta.

## D.3 Qué tan lejos está "multi-tenant channel-first"

**Sin cambios en el fondo, confirmado con más precisión.** 0 de 5 elementos completamente implementados (C.1), ahora verificado contra el Plan Maestro real en vez de una aproximación. Dos matices nuevos que sí cambian el detalle:
- El routing roto no es "falta de un WhatsAppChannel" en abstracto — es que el número `901781253` tiene un rol correcto y ya definido (**Platform Channel**, Secciones 3 y 42 del Plan Maestro: pruebas/QA/demos/soporte/onboarding) que hoy se está usando también como canal de facto de negocios que no son `CREA OS`.
- El gap no es solo "sin colas" — es una violación explícita y nombrada por el Plan Maestro (§14, "Webhook ≠ Procesamiento de IA"): el código actual llama a GPT de forma síncrona dentro del webhook, exactamente el patrón que el plan prohíbe.

## D.4 Qué tan lejos está CREA SALES AI™ de tener un cerebro operable sobre esa plataforma

**Confirmado, con el argumento de secuencia ahora respaldado por la fuente primaria en vez de inferido.** El Plan Maestro real ordena explícitamente Bloque A (Channel Core) → Bloque B (Runtime + piloto multi-tenant) → Bloque C (CREA Sales AI completo, M01-44 en bloque) — y en su propia lista de correcciones (§44) dice textualmente: *"No dejamos CREA Sales AI como un módulo posterior desconectado."* Construir cualquier engine de M01-44 antes de resolver el Bloque A+B real significaría construir inteligencia que solo puede alimentarse de datos de un único tenant — el mismo problema estructural actual, trasladado a una capa más cara y más difícil de deshacer.

## D.5 Nota de cambios (versión anterior → esta versión)

Detalle completo en **C.0**. Resumen: **nada de lo reportado antes quedó invalidado.** El Plan Maestro real confirma, con más autoridad y precisión, el diagnóstico completo de la Sección A y las conclusiones D.1-D.4 anteriores. Lo nuevo: (1) rol exacto del `901781253` como Platform Channel, (2) "Channel First" es 1 Tenant → N Channels, no 1:1, (3) los 17 campos exactos de `WhatsAppChannel` (incluye `tenantId` y `businessId` como campos separados), (4) prohibición explícita y nombrada de GPT síncrono dentro del webhook, (5) corrección de la columna "Fase" de la Sección B al Bloque A-E real del Plan Maestro (más simple: todo M01-44 es Bloque C, después de Bloque A+B de plataforma).
