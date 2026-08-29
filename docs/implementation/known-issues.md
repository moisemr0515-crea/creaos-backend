# Known issues — pendientes de seguimiento

Bitácora de hallazgos reales, fuera del alcance del PR donde se detectaron,
que quedan anotados para retomar como PR aislado más adelante. No confundir
con [`implementation-blueprint.md`](implementation-blueprint.md) (que es el
plan de una migración específica, Fases 0-3 del canal WhatsApp) — este
archivo es de propósito general, para cualquier módulo.

Cada entrada: fecha, estado, prioridad, archivos, problema, alcance
propuesto para el PR de seguimiento.

---

## 2026-08-17 — Silencio total ante fallas de `generateReply()` en el webhook de Gupshup

**Estado:** Abierto — no implementado.
**Prioridad:** Media-alta, no urgente.
**Detectado en:** revisión del PR #33 (`feat/tool-calling-escalate-to-human`), a raíz de una pregunta directa sobre si el nuevo corte de seguridad `MAX_TOOL_ITERATIONS` de `generateReply()` tenía cobertura de error aguas arriba.
**Archivos involucrados:** [`webhook.controller.js`](../../src/modules/webhooks/webhook.controller.js), [`ai.service.js#generateReply()`](../../src/modules/ai/ai.service.js).

### Problema

`webhook.controller.js` (el camino que mueve tráfico real de WhatsApp hoy) llama a `processGupshupMessage()` así:

```js
webhookService.processGupshupMessage(msg, config.business).catch((err) =>
  logger.error('[webhook] Gupshup processMessage error:', { message: err.message, stack: err.stack })
);
```

Fire-and-forget, sin `await`. Si `generateReply()` lanza en cualquier punto de esa cadena — Mongo caído, rate-limit de OpenAI, error de red, un `AppError` de negocio, y ahora también el corte de seguridad de `MAX_TOOL_ITERATIONS` agregado en el PR #33 — el único efecto observable es una línea en los logs. **El lead no recibe respuesta, ni un mensaje de fallback, ni nada: silencio total.**

**No es una regresión del PR #33** — este agujero ya existía antes, para cualquier causa de falla de `generateReply()`. El PR #33 solo agrega una causa más (el corte por tool calls sin converger), rara por diseño (un lead real no dispara 5 tool calls encadenadas en un turno).

Para contraste, los otros 2 call sites de `generateReply()` sí tienen algo de cobertura:
- `ai.controller.js#sendMessage` (HTTP, usado por el CRM para simular al lead): `try/catch` → `next(err)` → 500 JSON al frontend. Correcto, no es tráfico real de WhatsApp.
- `inbound.worker.js#processInboundJob` (BullMQ, **inactivo en producción** hoy): re-lanza, BullMQ reintenta, dead-letter + `InboundEvent.status='failed'` al agotar reintentos. Mejor cobertura, pero igual termina en "el lead no recibe nada" una vez agotados los reintentos.

### Alcance propuesto para el PR de seguimiento

- Fallback tipo "algo salió mal, en breve te contactamos" enviado al lead por WhatsApp cuando `generateReply()` falla en el camino del webhook.
- Antes de rendirse: un reintento **sin tools** (para separar si la falla es del loop de tool calling específicamente, o de `generateReply()` en general).
- Mantener el logging existente tal cual — agregar la respuesta al lead como capa nueva, no reemplazar nada.

---

## 2026-08-24 — "Nivel" y "Personalidad" de la IA (panel de negocio): ni persisten, ni hay lógica real esperándolos

**Estado:** Abierto — diagnóstico completo, sin implementar. Necesita decisión de producto antes de código (Track 5 del roadmap, no un fix chico de Track 1).
**Prioridad:** Media — no rompe nada activo, pero el usuario ve "Cambios guardados" sobre una selección que se pierde en el camino, siempre.
**Detectado en:** auditoría de pricing del 23/ago/2026 (Track 1 #4), investigación pedida explícitamente sin implementación.
**Archivos involucrados:** [`business.tsx`](../../../crea-os-ignite/src/routes/business.tsx) (frontend, UI + guardado), [`user.controller.js#updateMiPerfil()`](../../src/modules/users/user.controller.js), [`ai.service.js#buildSystemPrompt()`](../../src/modules/ai/ai.service.js), `Business.model.js`/`User.model.js` (backend, sin campo).

### Problema

Dos fallas independientes, no una sola:

**1. No persiste — bug de ruteo, mismo patrón que `onboarding_completed`.** El `<Select>` de Nivel (Básico/Avanzado) y Personalidad (Cercano/Formal/Agresivo) existe de verdad en `business.tsx:532-552`, con estado real (`p.ai_mode`/`p.ai_personality`). Pero `saveAll()` (`business.tsx:322-359`) manda esos 2 campos (junto con `script_welcome/followup/close`, `business_name`, `currency`, `monthly_goal`, `business_type`, los 3 `source_*_ads`, y los 2 `auto_*_enabled` — mismo camino roto, no auditados uno por uno) a `updateMe()` → `PUT /api/v1/users/me`, cuyo controller **solo lee `name`, `phone`, `avatar` del body** — todo lo demás se descarta en silencio, 200 OK igual. El endpoint correcto (`updateCurrentBusiness()` → `PUT /businesses/current`, donde sí vive `aiInstructions` funcionando) nunca recibe estos 2 campos. Ni `Business.model.js` ni `User.model.js` tienen un campo para guardarlos aunque el ruteo se arreglara.

**2. Aunque persistiera, no hay ninguna lógica que lo lea.** `grep` global de `aiMode|aiPersonality|ai_mode|ai_personality` en todo `src/` del backend: cero resultados fuera de este propio diagnóstico. `buildSystemPrompt()` (la única función que arma el prompt real que recibe el modelo) usa `productDescription`, `targetCustomer`, `pdfSummary`, `aiInstructions` (texto libre, el único lever real que existe hoy) y datos del lead — el tono está hardcodeado (`"profesional pero cercano y empático"`, `ai.service.js:236`) sin ninguna rama condicional por nivel o personalidad.

Es la misma familia de hallazgo que "Seguimiento automático"/"Cierre automático" (automatizaciones semilla con `trigger:'manual'`, sin lógica real) — pero acá es peor: ni siquiera hay un valor guardado en algún lado para mostrarle de vuelta al usuario. Cada recarga de pantalla vuelve al default (`"basico"`/`"cercano"`).

### Decisión pendiente (no técnica, de producto)

No hay "alcance propuesto para el PR" único acá — depende de qué se decida:
- **Cablear la lógica real**: arreglar el ruteo (mover `ai_mode`/`ai_personality` al payload de `updateCurrentBusiness()`, agregar los 2 campos a `Business.model.js`) + diseñar y escribir qué significa concretamente cada combinación en el prompt (bloques de tono condicionales en `buildSystemPrompt()`).
- **Sacar la feature de la UI** mientras no haya presupuesto de producto para la lógica real, para no seguir mostrando un control que no hace nada.

Queda para retomar junto con el resto de Track 5.

---

## 2026-08-28 — El "Business Brain" real es 5 campos de `Business` (de ~20) — moneda, ticket promedio y fotos de producto nunca llegan a la IA

**Estado:** Abierto — diagnóstico completo, sin implementar. Necesita decisión de producto (Track 5), no un fix chico.
**Prioridad:** Media-alta — no rompe nada activo, pero la IA vendedora opera con una fracción mínima del perfil que el negocio completa, con al menos un caso (moneda) que puede llevar a cotizar mal sin que nada lo detecte.
**Detectado en:** auditoría explícita pedida sobre qué tan real es el "Business Brain" (Plan Maestro §17), continuación del mismo criterio que el hallazgo de Nivel/Personalidad del 24/ago.
**Archivos involucrados:** [`ai.service.js#buildSystemPrompt()`](../../src/modules/ai/ai.service.js), [`webhook.service.js#processGupshupMessage()`](../../src/modules/webhooks/webhook.service.js), [`business.model.js`](../../src/modules/businesses/business.model.js), [`business.service.js#subirFotos()/subirPdf()`](../../src/modules/businesses/business.service.js).
**Corrección (2026-08-29):** el punto 2 original de este hallazgo decía mal cuál es el camino real de producción — ver el texto actualizado abajo. Detectado durante la investigación de PR-08 (inbound multi-tenant), al confirmar 2 env vars de Railway que no se habían chequeado juntas la primera vez.

### Problema

**1. La función que arma el prompt real es `buildSystemPrompt(business, lead, leadQualification)`** (`ai.service.js:209`), llamada desde `generateReply()` (`ai.service.js:354`). Recibe un objeto `business` — pero de sus ~20 campos, solo lee 5:

| Campo de `Business` | ¿Llega al contexto de la IA? | Archivo:línea |
|---|---|---|
| `name` | **Sí** | `business.model.js:7-13` → `ai.service.js:223` |
| `productDescription` ("Qué vende") | **Sí** | `business.model.js:94-99` → `ai.service.js:211` |
| `targetCustomer` ("Cliente ideal") | **Sí** | `business.model.js:107-112` → `ai.service.js:212` |
| `pdfSummary` (resumen del PDF, generado 1 vez al subirlo) | **Sí** (prioritario) | `business.model.js:46-50` → `ai.service.js:215-216` |
| `pdfExtractedText` (texto crudo del PDF, truncado a 5000) | **Sí** (solo fallback si no hay `pdfSummary`) | `business.model.js:38-42` → `ai.service.js:215-216` |
| `aiInstructions` ("Instrucciones para tu IA") | **Sí** | `business.model.js:120-125` → `ai.service.js:219-221` |
| **`currency`** (moneda del negocio) | **No** | `business.model.js:65-70` — ningún grep en `ai.service.js` |
| **`averageTicket`** (ticket promedio) | **No** | `business.model.js:101-105` — solo se usa para marcar `onboardingCompleted` (`business.service.js:58`), nunca se lee en `ai/` |
| **`photos`** (hasta 2 fotos de producto) | **No** | `business.model.js:25-32` — único uso en todo `src/` fuera de subir/borrar es `business.service.js:170` (borrado del anterior); cero referencias en `ai/` |
| `pdfUrl` (link crudo al PDF) | No directamente (pero alimenta `pdfExtractedText`/`pdfSummary`, que sí llegan) | `business.model.js:34-37` |
| `industry` | No | `business.model.js:55-59` |
| `country` | No | `business.model.js:60-64` |
| `phone` / `email` / `website` | No | `business.model.js:71-86` |
| `whatsappNumber` (distinto del canal real de envío) | No | `business.model.js:88-92` |
| `slug` / `logo` | No (ni tendría sentido) | `business.model.js:15-23` |
| `settings.language` | No — el idioma de respuesta se infiere del mensaje del lead (`ai.service.js:235`: "Responde siempre en el mismo idioma que el usuario"), nunca de `business.settings.language` | `business.model.js:157` |
| `onboardingCompleted` / `aiSalesEnabled` / `plan` / `planStatus` / `trialEndsAt` / `isActive` / `createdBy` | No — correcto que no lleguen, son flags de control/facturación, no contenido comercial | — |

**2. CORREGIDO (ver nota arriba) — el camino real de un mensaje de WhatsApp SÍ pasa `business` completo, no hay trampa activa hoy.** `WHATSAPP_CHANNEL_CORE_ENABLED=true` en Railway, pero eso solo decide que `webhook.controller.js` enrute a `inboundGateway.handle()` en vez del código legacy viejo — una SEGUNDA variable independiente, `WHATSAPP_QUEUE_PROCESSING_ENABLED`, está en `false` en Railway (confirmado 2026-08-29, no se había chequeado antes). Con ese flag en `false`, `inbound.gateway.js#handleOne()` (`inbound.gateway.js:118-128`) NO encola a BullMQ — llama directo y síncrono a `webhookService.processGupshupMessage(msg, tenantId)`, la misma función de siempre. Esa función hace `Business.findById(businessId)` sin `.select()` (`webhook.service.js:440`, documento completo) y lo pasa tal cual a `generateReply(conversation._id, business, lead)` (`webhook.service.js:598`) → `buildSystemPrompt(business, ...)` (`ai.service.js:354`), sin ningún objeto intermedio. **`inbound.worker.js` — con su `businessContext` recortado de 6 campos (`inbound.worker.js:228-235`) — está inactivo hoy** (su propio comentario, `inbound.worker.js:159-160`, ya lo decía: *"Este camino no está activo en producción todavía"*). Sigue siendo un gap real pero LATENTE: si en el futuro se activa `WHATSAPP_QUEUE_PROCESSING_ENABLED`, un campo agregado a `buildSystemPrompt()` sin tocar también `businessContext` de `inbound.worker.js` dejaría de funcionar en ese camino — pero hoy, un fix solo en `buildSystemPrompt()` alcanza para producción real.

**3. PDF: SÍ tiene un mecanismo real, no es decorativo.** `business.service.js#subirPdf()` (línea 179) extrae el texto del PDF (`PDFParse`), lo limpia, genera un resumen vía IA (`generarResumenPdf()`) y guarda ambos (`pdfExtractedText`/`pdfSummary`) — y esos 2 campos sí llegan al prompt (tabla arriba). Es el único de los 2 tipos de archivo que funciona como se esperaría.

**4. Fotos de producto: 100% decorativas para la IA — confirmado, no es una sospecha.** `subirFotos()` (línea 148) solo sube a Cloudinary y guarda las URLs en `Business.photos`. Ni una URL, ni una referencia, ni visión sobre la imagen llega a `buildSystemPrompt()` ni a ningún tool (`ai/tools/index.js` solo define `escalate_to_human`/`update_lead_stage`, ninguno toca `business.photos`). Un `grep` de `photos` en todo `src/` fuera del propio módulo `businesses/` da cero resultados.

### Impacto concreto (pedido explícito: no quedarse en "faltan campos")

- **Moneda:** un negocio cambia `currency` de `PEN` a `USD` en su perfil (campo real, editable, en `camposPermitidos` de `business.service.js:64`). La IA nunca supo la moneda en primer lugar — no hay ningún punto donde `business.currency` se lea. Si el negocio nunca escribió precios en `aiInstructions`/`productDescription` (texto libre), la IA simplemente no menciona montos nunca y el cambio es invisible. Si SÍ los escribió (ej. "planes desde S/300"), ese texto queda congelado en Soles para siempre — cambiar el selector de moneda en el perfil no actualiza nada de lo que la IA dice, y nada en el sistema avisa de este desfase.
- **Ticket promedio:** un negocio de consultoría define `averageTicket: 200` (USD). Un lead pregunta por un paquete claramente premium/atípico. La IA no tiene ninguna referencia numérica de qué es "normal" para ese negocio — no puede calibrar si está frente a una oportunidad de upsell grande o un lead desalineado con el ticket típico, ni ajustar el tono de negociación en consecuencia (Plan Maestro §17 lo lista como parte del Business Brain precisamente para esto). El campo existe, se guarda, se valida (`business.routes.js:59`) — y no hace nada más.
- **Fotos de producto:** un lead pregunta "¿cómo se ve el producto?" o pide una foto. El negocio subió 2 fotos reales esperando que sirvan de referencia — la IA no tiene forma de saber que existen, no puede describirlas, y no puede enviarlas (no hay ningún tool/flujo que despache `business.photos` como media saliente). La única foto que un lead puede llegar a recibir es la que un agente humano suba manualmente en el momento, no algo que la IA use de forma autónoma.

### Decisión pendiente (no técnica, de producto)

No hay un único "alcance propuesto" — depende de qué se priorice:
- **Ampliar `buildSystemPrompt()`** con `currency` (ej. "Cotiza siempre en {currency}") y `averageTicket` (ej. como ancla de calibración, no como precio fijo) — cambio acotado, mismo patrón que los 5 campos que ya funcionan, y suficiente por sí solo para producción hoy (punto 2 arriba, corregido). Tocar también `inbound.worker.js#businessContext` en el mismo PR es buena higiene preventiva (ese camino sigue inactivo, pero no cuesta nada mantenerlo en paridad) — no es requisito para que el fix funcione hoy.
- **Fotos:** decisión más grande — ¿vale la pena visión (describir la foto al modelo) o alcanza con un tool que las mande como media saliente cuando el lead las pide? Dos soluciones muy distintas en costo/complejidad para el mismo síntoma.
- **No tocar nada todavía** si Track 5 no lo prioriza — el hallazgo queda documentado para cuando se decida.

Queda para retomar junto con el resto de Track 5.
