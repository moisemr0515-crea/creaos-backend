# Implementation Blueprint — Fases 0 a 3

**Modo:** solo diseño. Ningún código de implementación en este documento; ningún archivo del repo fue modificado salvo la creación de este archivo.
**Fecha:** 2026-08-15
**Fuentes de verdad:** `docs/implementation/current-state-inventory.md` (auditoría + cruce con Plan Maestro, aprobado) y `docs/architecture/plan-maestro-crea-os.md` (v1.0, aprobado).
**Alcance:** Fases 0–3 del Plan Maestro (Secciones 24–33), con Fase 3 acotada explícitamente al **contrato de integración** hacia CREA Sales AI, no a la implementación de M01–M44.

---

## 1. Resumen y principios rectores

Este Blueprint traduce en trabajo ejecutable las Fases 0–3 del Plan Maestro, y cada decisión técnica de aquí en adelante se subordina a 4 principios innegociables que el propio plan declara no-negociables (§2, §5, §14, §41):

**Tenant First** — ningún dato comercial puede identificarse por número de teléfono, webhook, proveedor, usuario o lead; todo cuelga estructuralmente de un `tenantId` resuelto explícitamente, nunca asumido. **Channel First** — WhatsApp no es "el WhatsApp de CREA OS", es un `WhatsAppChannel` que pertenece a un tenant, y un tenant puede tener N channels (§2). **Webhook ≠ Procesamiento de IA** — ningún webhook puede quedar esperando una respuesta de GPT dentro del ciclo de request/respuesta; la secuencia obligatoria es `Webhook → Validate → Identify Channel → Persist Event → Queue → Worker → ... → Provider` (§14). **No acoplar el Core a Gupshup** — el dominio (`CRM`, `Leads`, `Conversations`, `Sales AI`, `Agents`, `Automations`) nunca debe llamar a `gupshup.sendMessage()` directamente; siempre pasa por `channelService.sendMessage()`, y el Gateway decide el proveedor (§5, §6, §41).

Cualquier decisión de este Blueprint que entre en tensión con alguno de estos 4 principios se marca explícitamente como **pregunta abierta**, no se resuelve por conveniencia de implementación.

---

## 2. Qué se conserva

| Pieza | Por qué se conserva tal cual |
|---|---|
| **`metaOauth.service.js`** completo (state CSRF vía Redis, intercambio de tokens, upsert por `{business, platform:'meta'}`, `disconnect()`) | Es multi-tenant real y correcto hoy — patrón de referencia a **estudiar** para el flujo de Embedded Signup de Fase 2, no a copiar 1:1 (el Plan Maestro §45 advierte no acoplar el Core a un proveedor concreto, y Meta OAuth está acoplado a Meta por diseño — se toma el *patrón* de OAuth-por-tenant, no el código). |
| **`auth.middleware.js` + `rbac.middleware.js` + `Role`/`Permission`** | RBAC granular, ya usado consistentemente en 12+ archivos de rutas. Ninguna pieza de Fase 0-3 requiere tocarlo — los nuevos endpoints de canal se protegen con el mismo `checkPermission()`. |
| **`AppError` + `error.middleware.js`** | Manejo de errores centralizado, ya mapea errores de Mongoose/JWT a HTTP consistentemente. Los nuevos servicios (`ChannelService`, `Gateway`, workers) lo reutilizan. |
| **Patrón de módulo por dominio** (`<módulo>/<módulo>.model|service|controller|routes.js`) | Es el patrón de todo el repo — `channels/` se construye siguiendo la misma convención, no una nueva. |
| **`WhatsAppConnection` (modelo)** | El Plan Maestro (§7) valida indirectamente su diseño: su `connectionType` (`PLATFORM/DEDICATED/MIGRATION`) es exactamente el tipo de estado que `WhatsAppConnection` empezó a simular. Se conserva sin tocar — no se migra ni se elimina en este Blueprint (ver §12). |
| **`Lead`, `Pipeline`, `Automation` (motor de reglas), `Conversation`** como modelos de dominio | Ninguno se reescribe. `Conversation` gana un campo nuevo (`channel` ref, ver §4.7); `Lead` gana normalización de `phone` (ver §7). El resto no cambia. |
| **Winston + `railway logs`** como fuente de logs | Sin cambios en esta fase — Observability avanzada (Fase 6 del plan) queda fuera de alcance (§12). |
| **Patrón de scripts de mantenimiento en `scripts/`** (uno por tarea, ejecutable con `node scripts/x.js`, con `dns.setServers(...)` cuando conecta a Atlas) | Se sigue el mismo patrón para los scripts de migración de Fase 0 (normalización de teléfonos, backfill de `WhatsAppChannel`), en vez de introducir un framework de migraciones nuevo — coherente con que el repo no tiene uno (auditoría, §18). |

---

## 3. Qué se adapta

| Pieza actual | Ubicación real | Qué cambia | Por qué |
|---|---|---|---|
| **`WebhookConfig`** | `src/modules/webhooks/webhookConfig.model.js` | Deja de ser la fuente de identidad del negocio para Gupshup. Se conserva el modelo (lo siguen usando Meta/TikTok, que sí son multi-tenant correctos), pero **el registro `platform:'gupshup'` existente deja de resolverse por `pageId` genérico** — la resolución de canal para WhatsApp pasa a `WhatsAppChannel` (nuevo modelo, §4.1). | El Plan Maestro (§7) es explícito: *"El modelo reemplaza la dependencia actual de `WebhookConfig` como identidad del negocio"* — para Gupshup específicamente, no para Meta/TikTok, que siguen funcionando igual. |
| **`webhook.service.js#processGupshupMessage()`** | `src/modules/webhooks/webhook.service.js:388-457` | Se reemplaza por completo. Hoy hace `businessId` fijo (recibido como parámetro desde el controller, resuelto por `findGupshupConfig()`) → `Lead.findOne/create` → `Conversation.findOne/create` → **llamada síncrona a `aiService.chat()`** → **`sendWhatsAppMessage()` síncrono**. El reemplazo separa esto en `Inbound Gateway` (valida + identifica canal + persiste evento + encola) y un `Worker` que consume la cola y recién ahí llama a la IA. | Viola directamente el principio "Webhook ≠ Procesamiento de IA" (§14 del plan) — confirmado como el riesgo #3 del inventario. |
| **`webhook.service.js#findGupshupConfig()`** | `src/modules/webhooks/webhook.service.js:340-350` | Se reemplaza por `ChannelResolver` (nuevo, §4.4), que resuelve por `phoneNumberId`/`wabaId` reales contra `WhatsAppChannel`, no por candidatos genéricos contra `WebhookConfig.pageId`. | Es literalmente el bug del Caso 8 — resolvía siempre al mismo único registro. |
| **`gupshup.client.js#sendWhatsAppMessage()`** | `src/modules/webhooks/gupshup.client.js` | Se envuelve detrás de `IChannelProvider` (nuevo, §4.2) como `GupshupProvider.sendMessage()`. La función en sí casi no cambia (sigue llamando a la misma API de Gupshup) — cambia **quién la llama**: nunca más directamente desde `ai.service.js` o `webhook.service.js`, siempre a través de `channelService.sendMessage()`. | Principio "no acoplar el Core a Gupshup" (§5) — hoy `ai.service.js#sendAgentMessage()` importa `gupshup.client.js` directo. |
| **`ai.service.js#sendAgentMessage()`** | `src/modules/ai/ai.service.js` (agregado en Caso 8 de esta sesión) | Cambia su única línea de envío: en vez de `sendWhatsAppMessage(lead.phone, text)` importado directo, llama a `channelService.sendMessage(channelId, lead.phone, text)`. El resto de la función (guardar el mensaje, fail-soft ante error, apagar `aiEnabled`) no cambia. | Mismo principio — y de paso resuelve que hoy no sabe "por cuál canal" está mandando (asume que solo existe uno). |
| **`Lead.phone`** | `src/modules/leads/lead.model.js:59` (`{type:String, maxlength:30, trim:true}`, sin normalización) | Gana normalización a E.164 al guardar + índice + protección contra duplicados. Ver plan completo en §7. | Confirmado con datos reales de producción: 3 formatos distintos para el mismo número en el mismo negocio. Plan Maestro §12 lo acredita como correcto. |
| **`scripts/seed-gupshup-webhook.js`** y **`scripts/update-gupshup-pageid.js`** | Raíz de `scripts/` | Se dejan de usar tras la migración (ver §5) — no se eliminan de golpe, se marcan como obsoletos con un comentario explícito hasta confirmar que nada los referencia y que el nuevo modelo está estable en producción. | Contienen el hardcode literal (`const BUSINESS_ID = '6a3a028d...'`) que originó todo este diagnóstico. |
| **`Conversation` (modelo)** | `src/modules/ai/conversation.model.js` | Gana **dos** campos: `channel: {type: ObjectId, ref: 'WhatsAppChannel'}` **además** del `channel: enum['whatsapp','web','email','manual']` de texto que ya existe (se renombra el campo existente a `channelType` para no chocar — ver nota en §4.7); y `tenantId` (indexado, backfill de `business` — ver §5.1, único caso de esta migración que toca una colección con datos existentes). | Hoy `Conversation.channel` es solo una etiqueta de texto; no hay forma de saber *cuál* WhatsApp la originó una vez existan varios por tenant. `tenantId` explícito es lo que permite que `TenantResolver`/`assertTenantScope` (§4.4, Decisión 1) validen la conversación en cada paso del pipeline sin tener que inferir el tenant indirectamente vía `Lead`/`Business`. |
| **`Business.plan`** | `src/modules/businesses/business.model.js` | **No se toca en este Blueprint** — ya identificado como vestigial en la auditoría, pero no bloquea Fases 0-3. Se deja documentado como deuda técnica para un Blueprint posterior. | Fuera del alcance de "Channel Core"; no lo menciona el Plan Maestro en Fases 0-3. |

---

## 4. Qué se construye desde cero

### 4.1 `WhatsAppChannel` (modelo)

Los 17 campos son los de la Sección 7 del Plan Maestro, literal:

```
id, tenantId, provider, providerAccountId, providerAppId,
phoneNumber, phoneNumberId, wabaId, businessId, status,
onboardingStatus, connectionType, credentialsReference,
webhookReference, displayName, createdAt, updatedAt
```

Notas de diseño (no cambian el contrato de campos, solo cómo se tipan en Mongoose):

- `status`: enum a definir — se propone `['pending','connecting','verifying','active','disconnected','error']`, heredado casi literal del enum ya usado en `WhatsAppConnection.status` (mismo vocabulario, consistencia con lo que ya existe).
- `onboardingStatus`: enum separado de `status` porque el plan los lista como campos distintos (§7) — representa el progreso del flujo de Embedded Signup (`not_started/in_progress/waba_created/phone_registered/completed/failed`), mientras `status` representa el estado operativo del canal ya existente.
- `connectionType`: enum `['PLATFORM','DEDICATED','MIGRATION']`, literal del plan (§7). El canal `901781253` se semilla como el único `connectionType: 'PLATFORM'` que debe existir (ver §6).
- `credentialsReference` / `webhookReference`: **nunca** credenciales en texto plano — son referencias (ej. a una env var, a un secret manager, o en V1 simplemente al nombre de la env var que las contiene: `GUPSHUP_API_KEY`). Coherente con el principio de seguridad del plan (§23: *"secrets fuera de la base de datos en texto plano"*).
- `tenantId` vs `businessId`: **DECIDIDO (ya no es pregunta abierta)** — `Business` se formaliza como el Tenant real, sin capa adicional encima (ver §5.1 para el detalle completo de la migración). `tenantId = businessId = Business._id`, pero no como un alias de conveniencia sin garantía — es un campo **requerido e indexado** en el schema, y todo el pipeline de canal (`ChannelResolver`, `TenantResolver`, `Gateway`, `Worker`) lo **valida en cada paso** contra `Business` (existencia + `isActive`), no lo asume por transitividad de un valor copiado.
- Índices: único compuesto `{provider, phoneNumberId}` (nunca 2 channels apuntando al mismo número real del mismo proveedor) y `{tenantId, status}` (queries de "canales activos de este tenant") — `tenantId` es `required: true` desde el día 1 en este modelo nuevo (no aplica backfill aquí, `WhatsAppChannel` no tiene datos previos).

### 4.2 `IChannelProvider` + `GupshupProvider`

Contrato (Plan Maestro §26, literal):

```
IChannelProvider
├── sendMessage(channel, to, text)
├── sendTemplate(channel, to, templateName, params)
├── sendMedia(channel, to, mediaUrl, caption)
├── getChannelStatus(channel)
├── registerWebhook(channel)
├── onboardChannel(tenantId, onboardingData)
├── disconnectChannel(channel)
└── normalizeInboundEvent(rawPayload) → CanonicalInboundMessage
```

`GupshupProvider` es la primera (y única, para Fase 0-3) implementación — envuelve lo que hoy es `gupshup.client.js` casi sin cambios internos, más los métodos nuevos que hoy no existen (`sendTemplate`, `sendMedia`, `getChannelStatus`, `registerWebhook`, `onboardChannel`, `disconnectChannel`) que se implementan como *stubs explícitos* (`throw new Error('not_implemented_v1')`) donde Fase 0-3 no los necesita todavía — **no se implementa `sendTemplate`/`sendMedia`/`onboardChannel` real en este Blueprint** (eso es Fase 2, Embedded Signup real; ver §9). El punto de este paso es fijar el contrato, no completar cada método.

**Actualización — PR-07a (Fase 2.1, post Embedded Signup real):** `sendMessage`/`sendTemplate`/`sendMedia`/`downloadMedia` recibían el `channel` completo desde sub-fase 1.b pero lo ignoraban — `gupshup.client.js` seguía resolviendo `apikey`/`source` (número origen)/`src.name` (nombre de app) de env vars globales (`GUPSHUP_API_KEY`/`GUPSHUP_PHONE_NUMBER`/`GUPSHUP_APP_NAME`), es decir, **todo tenant con un `WhatsAppChannel` DEDICATED (PR-06) seguía mandando y recibiendo media por el número/app compartido de PLATFORM**, violando Plan Maestro §3. Resuelto: esas 4 funciones ahora resuelven `channelCredentialsService.resolveCredentials(channel)` (ya existía desde Fase 2.0, sin usar hasta este PR) + `channel.phoneNumber`/`channel.providerAccountId`, y se los pasan a `gupshup.client.js` por parámetro — el canal PLATFORM sigue funcionando exactamente igual (`resolveCredentials()` para PLATFORM devuelve las mismas env vars de siempre). `listTemplates()`/`getChannelStatus()` quedan fuera de este PR a propósito (no son "envío"; siguen con el mismo gap, documentado como pendiente en el propio código).

`normalizeInboundEvent()` es donde vive la lógica que hoy está en `parseGupshupPayload()` (`webhook.service.js:289-325`) — se mueve tal cual a `GupshupProvider`, sin cambios de comportamiento, solo de ubicación.

**Nota de diseño (resuelve una ambigüedad menor del propio Plan Maestro):** el plan menciona `normalizeInboundEvent()` como método de `IChannelProvider` (§26) y también un "Event Normalizer" como pieza del Message Gateway (§27, §14). Se resuelve así: `normalizeInboundEvent()` en el Provider traduce el formato *específico de Gupshup* a un evento canónico (`{providerMessageId, from, text, channelIdentifiers}`); el "Event Normalizer" del Gateway (§4.3) no vuelve a tocar el formato del proveedor — solo enriquece ese evento canónico con el `WhatsAppChannel`/`tenantId` ya resueltos, antes de persistirlo. Son dos pasos distintos de la misma tubería, no una duplicación.

### 4.3 Message Gateway (Inbound / Outbound)

```
INBOUND:
Webhook HTTP → Validate (firma/token) → GupshupProvider.normalizeInboundEvent()
  → ChannelResolver.resolve(phoneNumberId/wabaId) → WhatsAppChannel + tenantId
  → Idempotency check (providerMessageId) → Persist Event (InboundEvent, nuevo modelo)
  → Queue.enqueue(eventId) → [HTTP 200 responde AQUÍ, antes de tocar IA]

OUTBOUND:
channelService.sendMessage(channelId, to, text)
  → Persist OutboundEvent (para trazabilidad + retry)
  → Queue.enqueue(outboundEventId) → Worker → GupshupProvider.sendMessage()
  → en fallo: Retry con backoff → tras N intentos: Dead Letter Queue
```

`InboundEvent` (modelo nuevo, mínimo): `{providerMessageId (único), provider, channel, rawPayload, status: 'received'|'processing'|'processed'|'failed', receivedAt, processedAt}`. Es el registro que responde "¿qué pasó con el mensaje X?" que pide el plan en Observability (§36) — aunque Observability completa queda fuera de alcance, este registro mínimo es gratis (ya lo estamos creando por idempotencia) y sienta la base.

`OutboundEvent` (modelo nuevo, simétrico): mismo propósito para el lado saliente — es lo que permite que `sendAgentMessage()` (Caso 8) reporte `whatsappStatus:'sent'/'failed'` con trazabilidad real, no solo el resultado inmediato de una llamada síncrona.

Dead Letter Queue: en V1 (BullMQ, ver §4.6) es una cola separada donde caen los `OutboundEvent`/`InboundEvent` que agotaron reintentos — no se auto-reprocesan, quedan visibles para revisión manual (vía un endpoint de admin simple, no un dashboard completo — Command Center es Fase 5, fuera de alcance).

### 4.4 `ChannelService` / `ChannelRepository` / `ChannelResolver` / `TenantResolver`

- **`ChannelRepository`**: acceso a datos puro sobre `WhatsAppChannel` (`findByPhoneNumberId`, `findByTenant`, `create`, `updateStatus`) — capa fina sobre Mongoose, mismo patrón que ya usan los demás módulos (el repo no tiene hoy una capa "repository" separada del `service`, así que esto es la primera vez que se introduce explícitamente esa separación — justificado porque `ChannelResolver` necesita queries muy específicas y cacheables por volumen de tráfico entrante).
- **`ChannelResolver`**: `resolve({provider, phoneNumberId, wabaId})` → `WhatsAppChannel | null`. Reemplaza a `findGupshupConfig()`. Cachea en Redis (TTL corto, ej. 60s) porque se llama en cada webhook entrante y el dato cambia poco.
- **`TenantResolver` — aislamiento estructural, no alias (Decisión 1)**: `resolve(channel)` → `tenantId`, pero **no es un simple `return channel.tenantId`**. Hace una validación activa contra `Business`: confirma que `Business.findOne({_id: channel.tenantId, isActive: true})` existe (mismo chequeo que ya hace `tenant.middleware.js#injectTenant` en la capa HTTP) antes de devolver el `tenantId` — si el negocio no existe o está inactivo, `TenantResolver` lo rechaza explícitamente en vez de dejar pasar un `tenantId` huérfano. Esto es lo que hace la resolución **estructural**: ningún paso del pipeline de canal puede procesar un evento para un tenant que no supere esta validación fresca, en vez de confiar en un valor copiado sin verificar (que es exactamente el patrón que originó el bug del Caso 8: un `businessId` fijo, nunca re-verificado).
- **`assertTenantScope(expectedTenantId, documentTenantId)`** (helper nuevo, usado en cada hand-off entre capas: antes de persistir `InboundEvent`, antes de encolar, antes de que el `Worker` procese, antes de llamar al `AgentRuntime`): lanza `AppError` si el `tenantId` que trae un documento en cualquier punto de la tubería no coincide con el que se resolvió originalmente — protección adicional contra que un bug futuro sustituya silenciosamente el tenant en algún paso intermedio.
- **`ChannelService`**: fachada pública que usa el resto del dominio — `sendMessage()`, `getChannelForTenant()`, `listChannels(tenantId)`. Es la única puerta de entrada — nadie fuera de `channels/` importa `GupshupProvider` ni `gupshup.client.js` directamente (cumple el principio de §5).

**Qué NO cubre esta formalización (alcance explícito, no una laguna oculta)**: `Lead`, `Pipeline`, `Automation` y el resto de colecciones existentes ya tienen `business` como campo `required: true` + indexado a nivel de schema (confirmado en la auditoría) — es decir, ya tienen aislamiento estructural *a nivel de dato*. Lo que NO tienen es aislamiento estructural *a nivel de query* (Riesgo #4, sin cambios — cada `service.js` sigue filtrando manualmente por `business: req.businessId`, sin un guard automático tipo `TenantResolver`/`assertTenantScope` en esas rutas). Extender este patrón a las ~20 colecciones existentes del dominio es un esfuerzo aparte, de mayor alcance que "Channel Core" — se deja fuera de este Blueprint a propósito, no por descuido.

### 4.5 Idempotency Key

Ver diseño completo en §8 — se resume aquí que la clave es `providerMessageId` (el `msgId` que ya extrae `parseGupshupPayload()` hoy, confirmado en la auditoría, simplemente nunca se usó para nada).

### 4.6 Queue / Workers — **DECIDIDO: BullMQ + servicio Railway independiente desde el día uno (Decisión 2)**

Motor de colas: **BullMQ** sobre el Redis Cloud ya provisionado (`REDIS_URL` en Railway, confirmado `*.db.redis.io` — Redis Cloud real, no un Redis local de desarrollo). Sin cambios respecto a la propuesta original:
- Cero infraestructura nueva de *colas* — Redis ya está pagado y conectado (`src/config/redis.js`, `ioredis` ya es dependencia).
- BullMQ es compatible con `ioredis` de forma nativa (mismo cliente).
- Da retries con backoff, colas separadas (inbound/outbound/dead-letter) y concurrencia configurable — exactamente los primitivos que pide §27/§28 del plan.

**Modelo de despliegue — cambia respecto a la propuesta original**: el `Worker` corre en un **segundo servicio de Railway, independiente del servicio de la API**, desde la primera sub-fase que lo introduce (1.d), no como una optimización futura. Diseño concreto:

- **Nuevo servicio Railway** (ej. `creaos-backend-worker`), mismo repositorio, distinto `startCommand` — mientras la API arranca con `npm start` (→ `node server.js`), el worker arranca con un entrypoint propio (ej. `node worker.js`) que **no** levanta Express ni escucha el puerto HTTP público — solo conecta a Mongo/Redis e inicia los `Worker` de BullMQ (inbound/outbound/dead-letter).
- **Variables de entorno compartidas**: Railway permite referenciar variables de otro servicio del mismo proyecto (`${{creaos-backend.MONGODB_URI}}` estilo Railway reference variables) — el worker no duplica secretos, los hereda del servicio API por referencia. Concretamente necesita: `MONGODB_URI`, `REDIS_URL`, `GUPSHUP_API_KEY`/`GUPSHUP_APP_NAME`/`GUPSHUP_PHONE_NUMBER`/`GUPSHUP_WABA_ID` (para que `GupshupProvider` funcione desde el worker), `OPENAI_API_KEY`/`OPENAI_MODEL` (para `AgentRuntime`). No necesita `JWT_SECRET`/`STRIPE_*`/`RESEND_API_KEY` — no sirve tráfico HTTP de usuarios ni maneja auth/pagos/emails.
- **Healthcheck propio**: el worker expone un servidor HTTP mínimo interno (puerto distinto, ej. una ruta `/health` en un puerto que Railway usa solo para su propio healthcheck de servicio, no expuesto públicamente) que reporta `{status:'ok', queues: {inbound: {waiting, active}, outbound: {...}}}` — coherente con el patrón `/health` que ya usa la API (`server.js`), pero verificando conexión a Redis/Mongo y estado de las colas, no solo "el proceso responde".
- **Costo/complejidad**: un servicio Railway adicional tiene costo de hosting propio — se acepta explícitamente como parte de esta decisión, a cambio de aislamiento real: un crash del worker (ej. un mensaje que rompe el procesamiento de forma inesperada) **no puede tumbar la API**, y viceversa. Ver Riesgo #11 (§10) — pasa de "mitigado" a **resuelto** por esta decisión.

Alternativa descartada explícitamente por esta decisión: correr el worker en el mismo proceso que la API (menor costo, pero acopla los ciclos de vida — ya no se considera para este Blueprint).

### 4.7 Agent Runtime Contract (solo el contrato — Fase 3 acotada)

El objetivo explícito de esta pieza (y de que Fase 3 esté en este Blueprint) es que **cuando lleguemos al Bloque C (M01-44) no haya que rediseñar cómo se conecta el cerebro con la plataforma**. Por eso se define la interfaz mínima ahora, implementada hoy por el `ai.service.js` actual (simple), y sustituible después por el Sales Brain real sin tocar el Message Gateway ni el Worker.

```
AgentRuntimeInput
├── tenantId
├── channelId
├── conversationId
├── leadId
├── message: { text, providerMessageId, timestamp }
├── businessContext: { name, productDescription, targetCustomer, pdfSummary, aiInstructions }
   (hoy: lo que ya arma buildSystemPrompt() en ai.service.js — se pasa tal cual)
└── conversationHistory: últimos N mensajes (hoy: Conversation.messages.slice(-10))

AgentRuntimeOutput
├── reply: string | null           (null si la decisión es "no responder todavía")
├── actions: Action[]              (hoy: vacío siempre — M01-44 no está implementado)
│     Action = { type, config }    (mismo shape que ya usa Automation.actions[], reutilizado a propósito)
├── aiEnabled: boolean             (para casos como escalate() que apagan la IA)
└── metadata: { tokensUsed, model, promptTokens, completionTokens }
```

La implementación de Fase 0-3 (`DefaultAgentRuntime`) es literalmente el `ai.service.js#chat()` actual envuelto para cumplir este contrato — sin agregar inteligencia nueva. El `Worker` de Fase 1.3 llama a `AgentRuntime.process(input) → output`, nunca a `openai.chat.completions.create()` directamente ni a `aiService.chat()` directamente — ese nivel de indirección es lo que permite que Bloque C, cuando llegue, reemplace `DefaultAgentRuntime` por el runtime real sin tocar el Worker, el Gateway, ni el Channel layer.

---

## 5. Plan de migración del hardcode de Gupshup (10 pasos)

| # | Paso | Detalle específico |
|---|---|---|
| 1 | **Localizar** | Ya confirmado con evidencia: `scripts/seed-gupshup-webhook.js:8`, `scripts/update-gupshup-pageid.js:8` (`const BUSINESS_ID = '6a3a028d8f0b137e53a05b82'`), y el registro único en la colección `webhookconfigs` de producción (`platform:'gupshup'`, `business: 6a3a028d8f0b137e53a05b82`). |
| 2 | **Identificar usos** | `webhook.service.js#findGupshupConfig()` (resuelve config por candidatos), `webhook.service.js#processGupshupMessage()` (recibe `businessId` ya resuelto, lo usa para `Lead.findOne/create` y `Conversation.findOne/create`), `webhook.controller.js` (punto de entrada HTTP que invoca lo anterior — confirmar función exacta al implementar, no auditada línea por línea en esta sesión). |
| 3 | **Identificar datos afectados** | Todos los `Lead`/`Conversation` con `source:'whatsapp'` bajo el negocio `CREA OS` (confirmado en el diagnóstico del Caso 8: al menos 2 conversaciones reales con historial, más los leads asociados). Ningún dato de `Myrel Company`/`Billions` está afectado porque nunca recibieron tráfico real vía Gupshup — su exposición es la ausencia de datos, no datos incorrectos. |
| 4 | **Backup** | Dump de las colecciones `webhookconfigs`, `leads` (filtrado `source:'whatsapp'`), `conversations` (filtrado `channel:'whatsapp'`) antes de tocar nada — vía `mongodump` con query filter, o export manual con un script de solo lectura (mismo patrón que los scripts de diagnóstico ya usados en esta sesión). |
| 5 | **Documentar temporalidad del número compartido** | Se agrega el `WhatsAppChannel` con `connectionType:'PLATFORM'` para `901781253`, con un campo de metadata/comentario explícito indicando que es un canal transicional heredado de la arquitectura anterior — no un canal "normal" más. |
| 6 | **Diseñar transición** | El `WebhookConfig` de `platform:'gupshup'` existente se conserva en modo lectura (nadie lo borra) durante la transición, pero el nuevo `ChannelResolver` deja de consultarlo — la resolución pasa 100% a `WhatsAppChannel`. Los datos históricos (`Lead`/`Conversation` bajo `CREA OS`) **no se reasignan** — coherente con Plan Maestro §24.6 (*"No reasignar automáticamente conversaciones históricas cuya pertenencia sea incierta"*). |
| 7 | **Implementar reemplazo** | `WhatsAppChannel` + `ChannelResolver` + `Inbound Gateway` (§4), con el webhook de Gupshup apuntando al nuevo flujo. Ver orden exacto de sub-fases en §9. |
| 8 | **Validar** | Contra Gupshup real: confirmar que un mensaje entrante al `901781253` (tráfico de QA) se sigue procesando igual que hoy (mismo negocio `CREA OS`, misma IA respondiendo) — es decir, que la migración no rompe el Caso 6 ya confirmado operativo. |
| 9 | **Rollback disponible** | Mientras el `WebhookConfig` viejo siga existiendo sin tocar, revertir es tan simple como apuntar el webhook de Gupshup de vuelta al handler anterior (feature flag simple, ver Pregunta Abierta #3) — no requiere restaurar backup si el paso 6 se respetó (no se destruyó nada). |
| 10 | **Eliminar dependencia antigua** | **Ventana de validación fijada en 14 días de tráfico real sin incidentes** (Decisión 3 — ver detalle completo y el paso de limpieza dedicado en §9, sub-fase 1.f). Solo al cumplirse esa ventana se marca `scripts/seed-gupshup-webhook.js` y `scripts/update-gupshup-pageid.js` como obsoletos y se retira `findGupshupConfig()` de `webhook.service.js`, **en un PR dedicado** — no como parte del corte mismo (paso 9). |

### 5.1 Backfill de `tenantId` en `Conversation` — sin downtime, con verificación 100% antes de depender de él (Decisión 1)

`Conversation` es la **única** colección existente (con datos reales) que este Blueprint toca a nivel de tenant-scoping — `WhatsAppChannel`/`InboundEvent`/`OutboundEvent` son modelos nuevos sin históricos, así que no necesitan backfill. El resto de colecciones (`Lead`, `Pipeline`, `Automation`, etc.) ya tienen `business` requerido+indexado desde su creación — no se tocan.

**Ubicación confirmada en §9**: los 3 PRs de esta secuencia van dentro de la sub-fase **1.a** (no en 0.a, que es estrictamente de solo lectura — ver el reporte de ejecución de 0.a, `docs/implementation/fase-0a-contencion-report.md` §4, y la confirmación explícita de esta ubicación). PR A se agrupa con la creación de `WhatsAppChannel` y el `pre('save')` de normalización de `Lead.phone` porque es el primer punto de la secuencia que ya toca modelos de dominio — no tiene sentido abrir una sub-fase de solo-schema separada para un cambio de una sola línea.

Secuencia (3 PRs separados, a propósito, para poder verificar entre cada uno):

1. **PR A — agregar el campo, opcional todavía** *(sub-fase 1.a)*: `tenantId` se agrega al schema de `Conversation` como campo **opcional** (`required: false`). Un `add field` sin `required` no exige backfill inmediato ni bloquea escrituras existentes — cero downtime, cero riesgo, porque Mongo/Mongoose no valida retroactivamente documentos ya guardados. En este mismo PR, el índice sobre `tenantId` se crea en background (`background: true` es el comportamiento por defecto de los índices de Mongo modernos — no bloquea lecturas/escrituras de la colección mientras se construye; al volumen actual de datos de este proyecto, del orden de segundos).
2. **PR B — backfill + script de verificación**: script (mismo patrón `scripts/`) que corre `Conversation.updateMany({tenantId: {$exists: false}}, [{$set: {tenantId: '$business'}}])` — idempotente (se puede correr más de una vez sin efecto secundario, ya que el filtro excluye documentos ya migrados). Termina con un script de verificación explícito: `Conversation.countDocuments({tenantId: {$exists: false}})` **debe devolver 0** antes de considerar este paso completo — se corre y su resultado (0) se documenta como evidencia en el PR, no se asume.
3. **PR C — endurecer el schema**: solo después de que PR B confirme 0 documentos sin `tenantId`, se cambia `required: false` → `required: true` en un PR separado. Recién en este punto `TenantResolver`/`assertTenantScope` empiezan a *depender* del campo — antes de este PR, cualquier código nuevo que lo use debe tratarlo como potencialmente ausente.

### 5.2 Los ~15 leads duplicados de `Myrel Company`, en el contexto de aislamiento estructural

La Decisión 1 no cambia el tratamiento que ya proponía §7 (revisión humana, sin fusión automática) — pero sí aclara **por qué es seguro** dejarlos para después: los 15 duplicados (mismo número real, hasta 3 formatos de `phone`) están **todos dentro del mismo `business`/tenant** (`Myrel Company`). Nunca hubo, ni hay, riesgo de fuga *entre* tenants en estos datos — es un problema de calidad de datos intra-tenant, no un problema de aislamiento. Como `Lead.business` ya es un campo estructuralmente válido (requerido+indexado desde siempre), la formalización de Tenant de esta sección no agrega nada que resolver ahí — confirma que están correctamente contenidos, lo cual es justamente el argumento para tratarlos como limpieza de datos de baja urgencia (§7, sin cambios) y no como parte del trabajo crítico de Fase 0-1.

---

## 6. Distinción Plataforma vs Cliente Real (`901781253`)

Diseño concreto que resuelve el riesgo #9 identificado en el inventario, **desde Fase 0-1, no diferido a Fase 2**:

1. **Fase 0**: se crea el primer (y por ahora único) `WhatsAppChannel` para `901781253`, con `connectionType:'PLATFORM'`, `tenantId`/`businessId` apuntando al negocio `CREA OS` (el mismo que ya lo tiene hoy vía `WebhookConfig`), `status:'active'`.
2. **Regla estructural, no una detección por mensaje**: el mecanismo que evita que un negocio nuevo "conviva con el fallback" no es clasificar cada mensaje entrante como QA-vs-cliente-real — es que, **a partir de Fase 1, ningún tenant nuevo puede tener un `WhatsAppChannel` con `connectionType:'PLATFORM'`** (validación a nivel de servicio: `ChannelService.createChannel()` rechaza `connectionType:'PLATFORM'` si el `tenantId` no es el de `CREA OS`). Como el routing (Fase 1) ya resuelve por `phoneNumberId`/`wabaId` real en vez de por negocio fijo, y `901781253` solo tiene **un** `WhatsAppChannel` (el de `CREA OS`), estructuralmente no hay forma de que otro tenant "reciba" ese tráfico — el bug de origen (routing a un `businessId` fijo) es precisamente lo que se elimina.
3. **Onboarding de un negocio nuevo (antes de que exista Embedded Signup real, Fase 2)**: mientras Fase 2 no esté lista, un negocio nuevo **no tiene ningún WhatsApp funcional** — no se le asigna el `901781253` como fallback "para que tenga algo". Esto es una decisión explícita: preferible que un tenant nuevo vea "WhatsApp no conectado todavía" a que reciba silenciosamente el canal de plataforma. Es coherente con Plan Maestro §8 (*"Un negocio nuevo NO debe nacer con el WhatsApp compartido... Debe nacer: Tenant → channels: []"*).
4. **Verificación**: un test de aceptación explícito (§11) confirma que `POST /channels` (o el mecanismo equivalente) rechaza la creación de un canal `PLATFORM` para cualquier tenant que no sea `CREA OS`.

---

## 7. Phone normalization y deduplicación

Plan concreto, siguiendo exactamente las reglas ya acordadas (detectar → backup → reportar → migrar sin fusión automática):

1. **Detectar formatos existentes**: script de solo lectura (mismo patrón que los scripts de diagnóstico de esta sesión) que recorre `Lead.phone` de todos los negocios, agrupa por "núcleo numérico" (últimos 9 dígitos, ignorando `+`/espacios/código de país) y reporta cuántos leads distintos comparten el mismo núcleo con formatos distintos — reproduce exactamente el análisis ya hecho manualmente en el Caso 8, pero como herramienta reutilizable.
2. **Backup**: dump de la colección `leads` completa (no solo los ambiguos) antes de cualquier escritura.
3. **Reporte**: salida del script en un archivo (no en la base de datos) listando, por negocio: `{phoneCore, variantes: [...], leadIds: [...], countConversaciones: [...]}` — para revisión humana antes de decidir qué hacer con cada grupo ambiguo.
4. **Normalización hacia adelante (sin tocar históricos todavía)**: `lead.model.js` gana un `pre('save')` (mismo patrón que ya usa `business.model.js` para el `slug`) que normaliza `phone` a E.164 en cada creación/edición nueva — esto detiene el sangrado inmediatamente, sin tocar un solo documento existente.
5. **Índice + protección contra duplicados**: índice compuesto `{business, phone}` (no único todavía — ver punto 7) para que las queries de "¿ya existe este lead?" (usadas hoy en `crearLead`, `processGupshupMessage`, `import.service.js`) puedan usar el número ya normalizado del payload entrante para buscar coincidencias reales, en vez de comparar strings crudos.
6. **Migración de históricos — sin fusión automática**: para los leads ya identificados como duplicados por formato (mismo núcleo numérico, mismo negocio), se normaliza el campo `phone` de cada uno a E.164 (esto es seguro, no fusiona nada, solo corrige el formato del string) — pero **no se fusionan los documentos entre sí automáticamente**, incluso si terminan con el mismo `phone` normalizado tras el paso anterior. La fusión de leads duplicados es una decisión de negocio (¿cuál de los 5 "Crea"/"Te quiero"/"Myrel" en `Myrel Company` es el real?) que requiere revisión humana, no un script.
7. **Índice único — solo tras confirmar que no quedan duplicados reales activos**: una vez que el reporte del paso 3 se haya revisado y resuelto manualmente (fusión o soft-delete de los duplicados que corresponda, decisión humana), recién ahí se puede promover el índice `{business, phone}` a único, para prevenir nuevos duplicados hacia adelante.

---

## 8. Idempotencia

Diseño concreto para eventos entrantes de Gupshup:

- **Clave de idempotencia**: `providerMessageId`, que es el `msgId` ya extraído hoy por `parseGupshupPayload()` (`webhook.service.js:289-325`, campo `msgId` en el objeto que retorna) — confirmado en la auditoría que existe en el payload real de Gupshup pero nunca se usó para nada más que pasar de largo.
- **Mecanismo**: `InboundEvent` (§4.3) tiene `providerMessageId` como **índice único** en Mongo. El `Inbound Gateway` intenta un `insertOne`/`findOneAndUpdate` con `{upsert:false}` antes de encolar; si Mongo rechaza por duplicado (`E11000`), el evento ya fue recibido — se responde `200 OK` al webhook (Gupshup no debe reintentar algo que ya confirmamos) sin volver a encolar ni volver a procesar.
- **Por qué Mongo y no un `SET` de Redis**: el Plan Maestro (§14) dice explícitamente `"Persist Event"` como paso propio, distinto de `"Queue"` — pide un registro durable, no solo una marca efímera. Un índice único de Mongo da exactamente esa durabilidad más el registro de auditoría (`InboundEvent` también sirve para responder "¿qué pasó con el mensaje X?", mencionado en Observability §36, aunque esa fase completa esté fuera de alcance).
- **Ventana de duplicados sin `providerMessageId`** (caso borde: si algún formato/payload de Gupshup llegara sin `msgId`, algo no confirmado que ocurra hoy pero posible): fallback a una clave compuesta `{phoneNumberId, from, text, timestamp redondeado al minuto}` — menos preciso, pero evita perder la protección por completo ante un payload atípico.

---

## 9. Orden de ejecución secuenciado

Cada sub-fase es un PR independiente y revisable — mismo flujo que se ha seguido en toda esta sesión (rama → PR → revisión → merge, sin tocar producción sin aprobación explícita).

### Sub-fase 0.a — Contención y backup (sin código de producto)
- **Qué se hace**: scripts de solo lectura para el reporte de duplicados de teléfono (§7.1) y el backup de las 3 colecciones (§5.4). Ningún modelo ni endpoint nuevo.
- **Qué se prueba**: el reporte corre contra producción (lectura, ya autorizado en sesiones anteriores) y produce el archivo de duplicados esperado — se compara contra los hallazgos ya conocidos del Caso 8 (mismos 3 números, mismos negocios) como validación de que el script es correcto.
- **PR(s)**: 1 — `scripts/report-phone-duplicates.js` + `scripts/backup-whatsapp-data.js`.
- **Riesgo si algo sale mal**: mínimo — son scripts de solo lectura, no tocan datos.
- **Rollback**: no aplica (nada se modifica).

### Sub-fase 1.a — `WhatsAppChannel` + normalización hacia adelante + `Conversation.tenantId` (PR A)
- **Qué se hace**: modelo `WhatsAppChannel` (§4.1), `pre('save')` de normalización en `Lead.phone` (§7.4), índice no-único `{business, phone}`. Se semilla el `WhatsAppChannel` de `901781253` (`connectionType:'PLATFORM'`, tenant `CREA OS`) vía script, replicando los datos del `WebhookConfig` actual — incluye el comentario de temporalidad pedido en la sub-fase 0.a (ver `fase-0a-contencion-report.md` §5). **Además**, se agrega `Conversation.tenantId` como campo opcional + índice en background (§5.1, PR A) — confirmado en esta sub-fase y no en 0.a porque es el primer punto de la secuencia que ya toca modelos de dominio.
- **Qué se prueba**: local + contra Mongo local — crear un lead con distintos formatos de teléfono y confirmar que todos quedan normalizados a E.164 al guardar. Confirmar que el `WhatsAppChannel` semilla existe y apunta al negocio correcto. Confirmar que `Conversation` acepta documentos con y sin `tenantId` (todavía opcional) sin error.
- **PR(s)**: 1 — modelo `WhatsAppChannel` + migración de normalización hacia adelante + script de seed del canal plataforma + campo `Conversation.tenantId` opcional/indexado (§5.1 PR A). Los PRs B (backfill + verificación) y C (`required: true`) de §5.1 pueden ir en el mismo PR o en PRs de seguimiento inmediatos — no bloquean nada de esta sub-fase ni dependen de `WhatsAppChannel`/`ChannelResolver`, así que su timing exacto queda a criterio de ejecución.
- **Riesgo**: bajo-medio — toca el modelo `Lead`, usado en todo el CRM. Mitigación: el `pre('save')` solo normaliza el formato, no rechaza ni fusiona nada; regresión cubierta con los mismos tests manuales usados en fixes anteriores de esta sesión. El campo `tenantId` en `Conversation` es aditivo y opcional, cero riesgo de romper escrituras existentes.
- **Rollback**: revertir el PR (el `pre('save')` es aditivo, no destructivo — leads ya guardados con formato viejo no se tocan retroactivamente en esta sub-fase; `tenantId` opcional tampoco requiere rollback de datos, solo de schema).

### Sub-fase 1.b — `IChannelProvider` + `GupshupProvider` + `ChannelService`/`ChannelRepository`/`ChannelResolver`/`TenantResolver`
- **Qué se hace**: las piezas de §4.2 y §4.4. `GupshupProvider` envuelve `gupshup.client.js` existente (sin reescribirlo). `ChannelResolver` funciona pero **todavía no está conectado al webhook real** — se prueba de forma aislada.
- **Qué se prueba**: unit-style manual (mismo patrón de scripts desechables usado en toda la sesión) — `ChannelResolver.resolve()` contra el canal semilla de la sub-fase 1.a, confirmar que resuelve al tenant `CREA OS` correctamente; `GupshupProvider.sendMessage()` mockeado (mismo patrón usado para probar `sendAgentMessage()` en Caso 8, sin mandar mensajes reales).
- **PR(s)**: 1.
- **Riesgo**: bajo — código nuevo, no reemplaza todavía nada que esté en producción.
- **Rollback**: revertir el PR, cero impacto en producción (nada lo usa aún).

### Sub-fase 1.c — Message Gateway (Inbound) + `InboundEvent` + idempotencia
- **Qué se hace**: `InboundEvent` (§4.3), `Inbound Gateway` que valida/identifica canal/persiste/checa idempotencia — **pero todavía sin cola real ni worker** (encola en un stub síncrono que llama directo al `AgentRuntime` contract, para poder probar de punta a punta antes de sumar la complejidad de BullMQ).
- **Qué se prueba**: contra Gupshup real en un entorno controlado (ideal: reutilizar el `901781253` de QA, que es exactamente para esto) — confirmar que un mensaje real entrante resuelve el canal correcto, se persiste el `InboundEvent`, y un reintento del mismo `providerMessageId` (simulado) no duplica nada.
- **PR(s)**: 1.
- **Riesgo**: medio — es el primer punto donde se toca el webhook real de Gupshup en producción. Mitigación: se prueba primero contra el canal de QA, no contra tráfico de negocio real (que hoy de todas formas no existe para otros tenants).
- **Rollback**: el webhook de Gupshup sigue apuntando al handler viejo hasta que este PR se valide explícitamente y se decida el corte (feature flag, Pregunta Abierta #3).

### Sub-fase 1.d — Queues/Workers (BullMQ, servicio Railway independiente) + Outbound Gateway + Agent Runtime Contract
- **Qué se hace**: se reemplaza el stub síncrono de 1.c por colas reales (inbound/outbound/dead-letter), y **un nuevo servicio Railway dedicado** (`creaos-backend-worker`, Decisión 2 — §4.6) que corre el `Worker` que las consume. `AgentRuntime` contract (§4.7) implementado por `DefaultAgentRuntime` (envoltorio de `ai.service.js#chat()` actual). `sendAgentMessage()` (Caso 8) se adapta para pasar por `channelService.sendMessage()`. Incluye: configurar el nuevo servicio en Railway (entrypoint propio, variables de entorno compartidas por referencia, healthcheck propio).
- **Qué se prueba**: de punta a punta contra el canal de QA — mensaje entrante real → cola → **worker corriendo en su propio servicio Railway** → `DefaultAgentRuntime` → respuesta de IA → cola de salida → worker → Gupshup → confirmar que el Caso 6 (IA respondiendo en WhatsApp real) sigue funcionando igual, ahora vía colas y en un proceso separado. Prueba adicional específica de esta decisión: forzar un error dentro del worker (ej. un mensaje malformado) y confirmar que la API sigue respondiendo normalmente durante y después del incidente — valida que el aislamiento de procesos realmente funciona, no solo que existe en el papel.
- **PR(s)**: 2 — (a) código de colas/worker/`AgentRuntime` contract en el repo, (b) configuración del nuevo servicio Railway (o el mismo PR si el equipo prefiere no separarlo — decisión de ejecución, no de diseño).
- **Riesgo**: alto — es el cambio más grande de esta secuencia, reemplaza el corazón del flujo de IA-por-WhatsApp que ya está operativo en producción, y agrega un servicio de infraestructura nuevo.
- **Rollback**: mantener el flujo viejo (`processGupshupMessage()` síncrono) disponible detrás del mismo feature flag hasta confirmar 100% de paridad de comportamiento — si el worker nuevo falla, el flag se apaga y el servicio worker simplemente queda sin tráfico (no hace falta desmontarlo).

### Sub-fase 1.e — Corte del webhook viejo, inicio de la ventana de validación (14 días)
- **Qué se hace**: el webhook de Gupshup en producción pasa a usar el nuevo flujo exclusivamente (feature flag `ON`). `findGupshupConfig()`/`processGupshupMessage()` quedan sin invocar, **pero el código NO se borra todavía** — el flag es temporal por diseño (Decisión 3), no un interruptor permanente.
- **Qué se prueba**: monitoreo activo (vía `railway logs`, como en toda la sesión) durante **una ventana de 14 días de tráfico real sin incidentes** — se elige 14 días (no 1-2 semanas vagas como en la versión anterior de este documento) porque cubre al menos 2 ciclos semanales completos de uso real del canal de QA, suficiente para exponer problemas de bajo volumen que un período más corto podría no capturar. Cero incidentes durante toda la ventana es el criterio de corte, no un número fijo de mensajes procesados.
- **PR(s)**: 1 (el corte del feature flag) + posibles hotfixes si aparece algo (cada hotfix reinicia el conteo de la ventana de 14 días desde el hotfix, no desde el corte original).
- **Riesgo**: alto — es el punto de no retorno operativo (aunque el rollback sigue siendo trivial mientras el código viejo exista).
- **Rollback**: revertir el feature flag, vuelve al flujo síncrono viejo instantáneamente.

### Sub-fase 1.f — Limpieza: eliminar feature flag y código del webhook viejo *(nueva — Decisión 3)*
- **Qué se hace**: **solo tras cumplirse la ventana de 14 días de 1.e sin incidentes**, PR dedicado que (a) elimina el feature flag y su rama condicional, dejando el nuevo flujo como el único camino en el código (sin `if`); (b) elimina `webhook.service.js#findGupshupConfig()` y `processGupshupMessage()`; (c) marca `scripts/seed-gupshup-webhook.js` y `scripts/update-gupshup-pageid.js` como obsoletos (comentario explícito, no se borran los archivos en esta sub-fase — eliminarlos físicamente es una limpieza cosmética posterior, sin riesgo, no bloquea nada).
- **Qué se prueba**: regresión completa del flujo de WhatsApp (mismo checklist que 1.d) corriendo sobre el código ya sin el flag — confirma que la limpieza no rompió nada que dependiera silenciosamente de la rama vieja.
- **PR(s)**: 1, dedicado exclusivamente a esta limpieza — nunca mezclado con una sub-fase que además cambie comportamiento, precisamente para que un rollback de este PR puntual sea trivial si algo se pasó por alto.
- **Riesgo**: bajo — en teoría solo se borra código ya no usado. El riesgo real es que algo *sí* dependiera silenciosamente de una de las dos rutas sin que 1.e lo hubiera expuesto en 14 días (ej. un caso raro de tráfico estacional). Mitigación: correr la regresión completa (arriba) antes de mergear.
- **Rollback**: revertir este PR puntual restaura el flag y el código viejo — sigue disponible en el historial de git aunque ya no esté en el árbol de trabajo.

**Nota de alcance**: el **Bloque A** del Plan Maestro (§46) no se considera completo hasta que **1.f** esté hecho — tener el nuevo flujo funcionando en paralelo detrás de un flag (fin de 1.e) es "validado", no "terminado". El código viejo sigue siendo una superficie de riesgo (puede reactivarse por error, confunde a quien lea el repo) mientras exista.

### Sub-fase 2.a — Embedded Signup (Fase 2 del plan)
- **Qué se hace**: implementación real de `GupshupProvider.onboardChannel()` (stub hasta ahora) siguiendo el flujo Meta Embedded Signup → WABA → Phone → Gupshup callback → `WhatsAppChannel` activo (Plan Maestro §9, §30).
- **Qué se prueba**: onboarding real de **un** número de WhatsApp nuevo, no el de plataforma.
- **PR(s)**: 1-2 (backend) + coordinación con Lovable para la UI de "Conectar WhatsApp".
- **Riesgo**: alto — depende de aprobación de Meta/Gupshup Partner Portal (mencionado en Plan Maestro §4 como "proceso en curso"), fuera del control puramente técnico.
- **Rollback**: el tenant piloto simplemente no tiene WhatsApp conectado — no afecta a nadie más.

### Sub-fase 2.1 — Primer tenant real (piloto)
- **Qué se hace**: `Myrel Company` (o el negocio piloto que se decida) conecta su propio `WhatsAppChannel` vía 2.a.
- **Qué se prueba**: inbound/outbound/templates/IA/CRM/aislamiento — checklist completo del Plan Maestro §31.
- **PR(s)**: ninguno necesariamente nuevo (es validación, no código) salvo fixes que surjan.
- **Riesgo**: medio — primer tenant real usando la tubería completa.
- **Rollback**: desconectar el canal del piloto sin afectar `901781253`.

### Sub-fase 2.2 — Piloto multi-tenant (2-3 negocios simultáneos)
- **Qué se hace**: repetir 2.1 con 2-3 tenants simultáneos.
- **Qué se prueba**: el criterio explícito del plan (§32): *"A jamás pueda acceder a B"* — test de aislamiento cruzado deliberado.
- **PR(s)**: ninguno necesariamente nuevo.
- **Riesgo**: medio-alto — es la primera prueba real de aislamiento bajo concurrencia.
- **Rollback**: desconectar canales individuales sin afectar a los demás tenants (aislamiento por diseño).

---

## 10. Riesgos y mitigaciones

| # | Riesgo (del inventario) | Mitigación concreta en este Blueprint |
|---|---|---|
| 1 | Gupshup single-tenant hardcodeado | Resuelto por diseño en §4.1-4.4 + migración en §5. |
| 2 | Sin idempotencia de mensajes | Resuelto por diseño en §8 (`providerMessageId` único en Mongo). |
| 3 | Webhook llama a GPT síncrono (viola §14) | Resuelto por diseño en §4.3 + sub-fase 1.d (cola/worker obligatorios antes de tocar IA). |
| 4 | Aislamiento por convención, no estructural | **Parcialmente mitigado, no resuelto del todo en este Blueprint** — el nuevo `ChannelResolver`/`TenantResolver` sí resuelven tenant de forma estructural para el flujo de canales, pero el resto del dominio (`leads`, `pipeline`, etc.) sigue dependiendo de que cada `service.js` filtre manualmente por `business`. Mitigación propuesta: agregar un test de aceptación explícito (§11) que verifique aislamiento cruzado en el piloto (2.2), como red de seguridad, no como solución estructural completa (eso requeriría un Blueprint propio de "tenant isolation a nivel de framework", fuera de alcance aquí). |
| 5 | Cero tests / Evaluation Engine | **No resuelto por este Blueprint** — fuera de alcance (Bloque C). Mitigación parcial: cada sub-fase de §9 define qué se prueba manualmente antes de avanzar, como sustituto temporal de tests automatizados. |
| 6 | Sin tool/function calling de OpenAI | **No resuelto — es Bloque C**, fuera de alcance. El `AgentRuntimeOutput.actions[]` (§4.7) deja el contrato listo para cuando se implemente. |
| 7 | `Lead.phone` sin normalizar | Resuelto por diseño en §7. |
| 8 | Logs de producción no persisten en Railway | **No resuelto** — Observability es Fase 6, fuera de alcance. Mitigación parcial: `InboundEvent`/`OutboundEvent` (§4.3) dan trazabilidad mínima en Mongo (que sí persiste), independiente de los logs de archivo. |
| 9 | Número `901781253` sin distinción plataforma/cliente | Resuelto por diseño en §6. |
| 10 | **`Business` formalizado como Tenant, sin capa adicional — RESUELTO por Decisión 1**, con una advertencia nueva (ver Pregunta Abierta #1 actualizada, abajo): tanto el Plan Maestro real (§7, `WhatsAppChannel` tiene `tenantId` y `businessId` como campos separados) como el Módulo 48 (diagrama explícito `TENANT → BUSINESS A/B/C`) — y una necesidad de producto ya mencionada explícitamente por el usuario en una sesión anterior de este mismo proyecto ("un usuario puede administrar más de un negocio, ej. una inmobiliaria y una academia") — sugieren que eventualmente puede hacer falta un Tenant por encima de `Business`. | Se resuelve el riesgo inmediato (`TenantResolver` ya no es un alias sin garantía, valida activamente) sin cerrar la puerta a futuro: `tenantId` sigue apuntando a `Business._id` (no a un ID inventado), así que si más adelante se necesita un `Tenant` real conteniendo varios `Business`, el cambio es agregar un nuevo nivel (`Business.tenantGroupId` o similar) sin tener que re-emitir los `tenantId` ya persistidos en `WhatsAppChannel`/`Conversation`/`InboundEvent`/`OutboundEvent`. |
| 11 | **BullMQ corriendo en el mismo proceso que la API acoplaba el ciclo de vida de ambos** — **RESUELTO por Decisión 2**, no solo mitigado: el worker corre en un servicio Railway independiente desde el día uno (§4.6). Un crash procesando un mensaje ya no puede tumbar la API bajo ningún escenario, porque son procesos y servicios distintos. Se mantiene el try/catch exhaustivo en `Worker.process()` como buena práctica adicional (mueve a Dead Letter Queue en vez de perder el evento), pero ya no es la única línea de defensa. |

---

## 11. Criterios de aceptación (Fases 0–2.2)

Fases 0-2.2 se consideran completas cuando, **todo simultáneamente**:

1. **Fase 0**: el reporte de duplicados de teléfono existe y fue revisado; existe backup verificable de las 3 colecciones; el `WhatsAppChannel` de `901781253` existe con `connectionType:'PLATFORM'`.
2. **Fase 1 (Channel Core)**: un mensaje real entrante al `901781253` se resuelve vía `ChannelResolver` (no vía `WebhookConfig`), y produce el mismo resultado observable que hoy (IA responde en WhatsApp real) — validado contra el Caso 6 ya confirmado, sin regresión.
3. **Idempotencia**: reenviar deliberadamente el mismo `providerMessageId` (simulando un reintento de Gupshup) produce exactamente 1 `Lead`/respuesta/mensaje saliente, no más — probado explícitamente, no asumido.
4. **Webhook ≠ IA**: confirmado por diseño de código (el handler HTTP del webhook responde `200` antes de que exista ninguna llamada a OpenAI en el stack de esa request) — verificable revisando que `Inbound Gateway` encola y retorna, y que el `Worker` corre en un ciclo de evento separado **en un servicio Railway independiente** (Decisión 2).
5. **Distinción plataforma/cliente real**: intentar crear un `WhatsAppChannel` con `connectionType:'PLATFORM'` para un tenant que no sea `CREA OS` es rechazado explícitamente (test de aceptación dedicado).
6. **Aislamiento estructural de tenant (Decisión 1)**: `TenantResolver` rechaza explícitamente un `tenantId` cuyo `Business` no existe o está inactivo (test dedicado); el backfill de `tenantId` en `Conversation` reporta 0 documentos sin el campo antes de promoverlo a `required` (§5.1); el worker en su servicio Railway separado sigue funcionando con normalidad tras forzar un error dentro del procesamiento de un mensaje (prueba de aislamiento de proceso, sub-fase 1.d).
7. **Bloque A completo (no solo validado)**: sub-fase 1.f ejecutada — feature flag y código del webhook viejo (`findGupshupConfig()`, `processGupshupMessage()`) eliminados, tras cumplir los 14 días de ventana de validación sin incidentes (Decisión 3). Mientras 1.f no esté hecho, Fase 1 se considera "validada en paralelo", no "completa".
8. **Fase 2.1 (primer tenant real)**: el negocio piloto completa el checklist del Plan Maestro §31 (onboarding, WABA, phone, webhook, inbound, outbound, IA, CRM, aislamiento) sin usar ni tocar el `901781253`.
9. **Fase 2.2 (piloto multi-tenant)**: con 2-3 tenants conectados simultáneamente, un test de aislamiento cruzado deliberado confirma que ninguno puede ver leads/conversaciones/mensajes de otro — criterio literal del Plan Maestro §32.
10. **Ningún dato histórico se reasignó automáticamente** — los leads/conversaciones que hoy viven bajo `CREA OS` por el bug de origen siguen ahí, sin fusión ni migración automática hacia otros tenants (coherente con §24.6 del plan).

---

## 12. Qué queda explícitamente fuera de este Blueprint

Confirmado contra el orden del propio Plan Maestro (§46) — todo lo siguiente es **Bloque C en adelante**, posterior a que Fases 0-2.2 estén validadas:

- **Bloque C completo**: implementación real de M01-44 (Sales Brain, Business Brain, Buyer Intelligence, Psychological State, Objection Engine, Micro-Closing, Memory estructurada, Action Engine con tool/function calling real, Human Handoff automático, Lead Intelligence consolidado, Follow-up Engine con trigger por tiempo, Personality, Learning, Evaluation, Model Routing). Este Blueprint solo entrega el **contrato** que Bloque C va a consumir (§4.7).
- **`WhatsAppConnection`**: no se toca, no se migra, no se elimina — sigue siendo el placeholder correcto para el modelo de número dedicado (ticket #264467), consistente con la decisión ya tomada en el Caso 8.
- **`Business.plan` vestigial**: documentado como deuda técnica, no se resuelve aquí.
- **Command Center** (Fase 5 del plan) — administración de tenants/canales/agentes/billing desde un panel; depende de que Channel Core (esta fase) esté estable primero, por diseño explícito del propio plan (§35).
- **Billing y economía del agente** (Fase 9).
- **Observability avanzada** (Fase 6) — métricas, tracing, dashboards de latencia/costo. Este Blueprint entrega solo el registro mínimo (`InboundEvent`/`OutboundEvent`) que sienta la base, no la capa de observabilidad completa.
- **Meta Direct Provider** (Fase 7/Bloque E) — la migración `GupshupProvider → MetaDirectProvider` que el plan ya diseña (§41) queda preparada conceptualmente (por eso existe `IChannelProvider` como abstracción desde ahora), pero no se implementa una segunda implementación del contrato en este Blueprint.
- **Multi-provider / Omnichannel** (Fase 8/Bloque E) — Instagram, Messenger, Web Chat, SMS, Email. El diseño de `WhatsAppChannel`/`IChannelProvider` no los bloquea a futuro, pero no se construyen ahora.
- **Escala global** (Fase 10) — miles/millones de tenants. El diseño de esta fase apunta a no bloquearla (colas, tenant isolation en el routing), pero no se prueba a esa escala aquí — el criterio de aceptación de esta fase es 100 usuarios / 2-3 tenants piloto, no 10,000.

---

## Preguntas abiertas

### ✅ Pregunta 1 (ORIGINAL) — DECIDIDA: `Business` = Tenant real, formalizado estructuralmente, sin capa adicional

Ver diseño completo en §4.1, §4.4, §5.1, §5.2. `tenantId = businessId = Business._id`, validado activamente (no asumido) en cada paso del pipeline de canal.

### 🆕 Pregunta 1-bis (nueva, surgida directamente de implementar la Decisión 1) — ¿Hace falta un `Tenant` por encima de `Business` a futuro, y cuándo?

La instrucción explícita fue *"Business sigue siendo la unidad raíz — solo se formaliza como Tenant estructural, sin capa adicional encima"*, y así se diseñó. Pero al revisar las fuentes contra esa asunción, encontré 3 señales — ninguna decide por sí sola que haga falta ahora, pero las marco tal como se pidió en vez de descartarlas:

1. **El propio Plan Maestro real (§7)** modela `WhatsAppChannel` con `tenantId` **y** `businessId` como campos separados — no como sinónimos. Con la Decisión 1 ambos quedan con el mismo valor hoy, pero el plan los diseñó como potencialmente distintos.
2. **El Módulo 48** (`Multi_Tenant_Data_Architecture`, parte de CREA SALES AI™, documento separado del Plan Maestro) diagrama explícitamente `TENANT → BUSINESS A/B/C` — un tenant conteniendo varios negocios.
3. **Necesidad de producto ya mencionada por el usuario en esta misma línea de trabajo** (Caso 2, sesión anterior): *"un usuario puede administrar más de un negocio (ej. una inmobiliaria y una academia)"* — esto no es una inferencia mía de los documentos, es algo que el usuario ya dijo que necesita.

**No se resuelve aquí — sigue sin ser necesario para Fases 0-3** (ninguna pieza de Channel Core requiere que un negocio pertenezca a un Tenant distinto de sí mismo). Queda marcada para que, cuando ese momento llegue, no se trate como una sorpresa: el punto de extensión ya está diseñado (§10, riesgo #10) — agregar un nivel por encima de `Business` no requeriría re-emitir los `tenantId` ya guardados.

### ✅ Pregunta 2 (ORIGINAL) — DECIDIDA: BullMQ + servicio Railway independiente desde el día uno

Ver diseño completo en §4.6 y sub-fase 1.d (§9).

### ✅ Pregunta 3 (ORIGINAL) — DECIDIDA: feature flag temporal, ventana de 14 días, limpieza en sub-fase dedicada

Ver §5 (paso 10), sub-fases 1.e/1.f (§9). El flag existe solo entre el corte (1.e) y la limpieza (1.f) — nunca es un mecanismo permanente del código.

### Pregunta 4 (sin cambios — sigue abierta) — ¿Qué pasa con los ~15 leads duplicados de teléfono de `Myrel Company`?

La Decisión 1 explica **por qué es seguro** postergarlos (§5.2 — están 100% contenidos dentro de un solo tenant, nunca fue un problema de aislamiento) pero no decide la acción de negocio en sí (¿cuál de los 5 "Crea"/"Te quiero"/"Myrel" es el real? ¿se fusionan, se archivan los duplicados?). Sigue siendo una decisión humana pendiente, fuera del alcance técnico de este Blueprint — se resuelve en la revisión manual del reporte de la sub-fase 0.a (§9), sin bloquear ninguna sub-fase posterior.
