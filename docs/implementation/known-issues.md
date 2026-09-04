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

## 2026-09-04 — Incidente real de Embedded Signup: 401 de Gupshup deslogueaba al usuario; endpoint de suscripción equivocado; "Invalid URL Passed" por nuestro propio webhook

**Estado:** RESUELTO y CONFIRMADO EN VIVO — las 3 causas arregladas, mergeadas (PR #75, #76) y desplegadas; la suscripción a eventos ACCOUNT contra la sesión real del incidente ya devuelve 200. Queda un paso manual pendiente (no bloqueante para este bug): que alguien complete el `embedSignupUrl` para que el `WhatsAppChannel` DEDICATED se termine de crear — ver "Confirmación en vivo post-deploy" al final.
**Prioridad:** Alta (bloqueaba completar un Embedded Signup real de punta a punta) — ya no bloquea.
**Detectado en:** primer intento real de Embedded Signup en producción, tenant "Nutriva Corp" (`6a9340ae5af267a3ffd8b1b5`), sesión `6a9ae932fe38b2ca69042e03`, appId de Gupshup `cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4`.
**Archivos involucrados:** [`partner.errors.js`](../../src/modules/channels/providers/gupshup/partner/partner.errors.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js), [`error.middleware.js`](../../src/middleware/error.middleware.js), [`auth.middleware.js`](../../src/middleware/auth.middleware.js), [`channel.controller.js`](../../src/modules/channels/channel.controller.js), [`channelOnboardingWebhook.controller.js`](../../src/modules/channels/channelOnboardingWebhook.controller.js) (nuevo), [`channelOnboardingWebhook.constants.js`](../../src/modules/channels/channelOnboardingWebhook.constants.js) (nuevo), [`webhook.routes.js`](../../src/modules/webhooks/webhook.routes.js), [`client.ts` (crea-os-ignite)](../../../crea-os-ignite/src/lib/api/client.ts).

### Causa 1 (RESUELTA, mergeada) — 401 de Gupshup deslogueaba al usuario

Un 401 de Gupshup (nada que ver con la sesión del usuario) se reenviaba tal cual como HTTP 401 al frontend. `apiFetch()` (`client.ts`) trataba CUALQUIER 401 en un endpoint no-auth como "tu sesión expiró" y deslogueaba a la fuerza. Fix: `partner.errors.js` ya no mapea ningún error de Gupshup a 401 (pasa a 502); `AppError` ganó un `code` opcional, `auth.middleware.js` marca sus 401 con `AUTH_SESSION_INVALID_CODE`; `client.ts` solo desloguea si el 401 trae ese código exacto. Mergeado en PR #75.

### Causa 2 (RESUELTA, mergeada) — endpoint de suscripción equivocado

`POST https://api.gupshup.io/wa/app/{appId}/subscription` (Subscription API "self-serve", tier de mensajería) respondía 401 de forma CONSISTENTE — probado en vivo con backoff de hasta 9s, y hasta horas después del intento original, descartando la hipótesis de "propagación lenta" documentada antes acá. Causa real: ese endpoint es para apps YA live con WABA verificado (como el canal PLATFORM); nuestra app nueva nunca llegó a ese punto. El endpoint correcto es `POST https://partner.gupshup.io/partner/app/{appId}/subscription` ("Set subscription for an app", Partner Portal), con nota textual propia: *"Subscriptions can now be set for sandbox apps as well."* — pensado exactamente para este caso. Fix con header `Authorization` (no `apikey`), `modes` sin corchetes, `version: 3`. Probado en vivo contra la sesión real: **el 401 desapareció** (avanzó a la Causa 3).

### Causa 3 (RESUELTA, mergeada Y confirmada en vivo — PR #76) — "Invalid URL Passed" era nuestro propio webhook, no Gupshup

Con el endpoint corregido, la llamada ya no daba 401 — pero Gupshup respondía `400 {"status":"error","message":"Invalid URL Passed"}` para el campo `url`, incluso probando con un dominio ajeno reconocido (`https://example.com/webhook`), sin path, con/sin percent-encoding, con `version` 2 y 3, y descartando un problema de form-urlencoded vs JSON (JSON da un error DISTINTO — `"Required request parameter 'modes'..."` — confirmando que `url` SÍ se parsea correctamente y el rechazo es sobre su contenido).

**Causa raíz real, confirmada en 2 pasos:**
1. `docs.gupshup.io/docs/webhook-key-points` documenta que un webhook debe devolver `2xx` y "aceptar el evento de usuario `sandbox-start`" — evidencia de que Gupshup valida la URL con un ping antes de aceptar la suscripción.
2. Confirmado con un curl directo contra nuestro propio endpoint: `POST /api/v1/webhooks/gupshup` sin el header `GUPSHUP_WEBHOOK_TOKEN` devuelve **401**, no 2xx (`webhook.service.js#verifyGupshupAuth()` exige ese secreto en TODO POST). Un ping de verificación de Gupshup para una app nueva no tiene forma de conocer ese secreto — nuestro propio endpoint rechazaba la validación, y Gupshup lo reportaba hacia afuera como "Invalid URL Passed". El mismo control también habría bloqueado el evento real `ACCOUNT_VERIFIED` más adelante, no solo el ping inicial.

**Nota sobre el "control" con `example.com/webhook`:** en su momento pareció descartar cualquier explicación ligada a nuestro dominio — en retrospectiva, `https://example.com/webhook` devuelve **404** (no 2xx), así que en realidad fallaba por el mismo tipo de motivo (no-2xx), no porque el chequeo de Gupshup sea independiente del contenido de la URL. No invalida la conclusión, la reafirma.

### Decisión de diseño: NO tocar `/api/v1/webhooks/gupshup`

`/api/v1/webhooks/gupshup` tiene tráfico real de producción hoy (canal PLATFORM) y está dentro de la ventana de validación de 14 días del Bloque A — se descartó relajar `verifyGupshupAuth()` o cambiar el orden ACK/validación de ese endpoint. En su lugar: **una ruta de callback completamente nueva y separada**, exclusiva del flujo de Embedded Signup:

- `GET|POST /api/v1/webhooks/gupshup/onboarding/:appId` (`channelOnboardingWebhook.controller.js`, nuevo) — mismo Express router (`webhook.routes.js`), controller y secreto (`GUPSHUP_ONBOARDING_WEBHOOK_TOKEN`, nueva env var) 100% independientes de `webhook.service.js`/`GUPSHUP_WEBHOOK_TOKEN`. `:appId` en el path (no en el body) — cada suscripción ya apunta a una URL con el appId correcto embebido, así que `handleGupshupAccountVerified()` se llama con el path param, no con un campo del payload (más robusto ante un ping de verificación con shape impredecible).
- El secreto viaja a Gupshup vía el campo `meta` de `POST /partner/app/{appId}/subscription` — documentado por Gupshup como `{"headers": {...}}`, custom headers que reenvía en cada request a la URL suscripta. `partner.subscriptions.js#subscribeToEvents()` ganó un parámetro `headers` opcional para esto.
- `channelOnboardingWebhook.constants.js` (nuevo, sin dependencias propias): el nombre del header vive acá, no en el controller — importarlo directo desde `channel.controller.js` habría formado un require circular real (`channel.controller.js` → `channelOnboardingWebhook.controller.js` → `channelOnboardingCompletion.service.js` → `channel.controller.js`, dejando `nombreAppGupshup` `undefined` del otro lado). Encontrado y evitado antes de commitear, no en producción.
- `webhook.service.js`, `verifyGupshupAuth()`, `GUPSHUP_WEBHOOK_TOKEN` y el endpoint `/api/v1/webhooks/gupshup` existente: **sin ningún cambio**.

Tests nuevos: `channelOnboardingWebhook.controller.test.js` (10 tests: auth fail-closed, ACK 2xx siempre que la auth pase, dispara `handleGupshupAccountVerified` solo ante un payload ACCOUNT_VERIFIED real, no-op silencioso ante cualquier otro payload como el ping de verificación). `partner.subscriptions.test.js` ampliado (parámetro `headers`→`meta`). `channel.controller.test.js` actualizado (URL nueva, header nuevo, guard de env var faltante). Suite completa: 289/289.

### Intento previo al deploy: por qué la prueba en vivo no confirmaba nada todavía

Reintentado en vivo contra la sesión real ANTES de mergear/desplegar el PR: **seguía dando "Invalid URL Passed"**. Investigado por qué antes de asumir que el fix estaba mal: un `curl` directo a la ruta nueva contra el servidor de producción REALMENTE DESPLEGADO devolvía 401 "Token de autenticación requerido" — porque el código de la rama todavía no estaba desplegado (`railway run` ejecuta el código local contra las env vars/DB de producción para los scripts de un solo uso, pero la Subscription API de Gupshup necesita poder alcanzar la URL por HTTPS real — eso solo lo sirve el contenedor efectivamente desplegado). Confirmado que CUALQUIER path no reconocido bajo `/api/v1/webhooks/*` caía en el `router.use(authenticate, injectTenant)` de `webhook.routes.js` y devolvía ese mismo 401 — coincidía exactamente con lo observado. Se decidió no hacer `railway up` manual (afecta el contenedor que sirve tráfico real de PLATFORM) y esperar el merge/deploy real vía PR — igual que con el resto de los fixes de este mismo incidente.

### Confirmación en vivo post-deploy (04/sep/2026, mismo día) — RESUELTO

PR #76 mergeado a `main` → deploy en Railway confirmado exitoso (`railway deployment list`: `status: SUCCESS`, `commitHash` desplegado = HEAD de `main`). Confirmado además con un `curl` directo que la ruta nueva ya respondía 200 en el servidor real (antes del deploy daba 401).

Reintentada la suscripción contra la MISMA sesión real del incidente (`6a9ae932fe38b2ca69042e03`, appId `cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4`, tenant Nutriva Corp):

```
POST /partner/app/cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4/subscription
→ 200 (antes: 400 "Invalid URL Passed")
```

El flujo completo avanzó de punta a punta en la misma corrida — algo que nunca se había alcanzado en ningún intento anterior — incluyendo `setContactDetails` (200) y `getEmbedSignupLink` (200, generó un `embedSignupUrl` real y nuevo).

**Estado de la sesión, antes → después de esta corrida:**

| Campo | Antes | Después |
|---|---|---|
| `status` | `failed` | `gupshup_registering` |
| `error.step` / `error.message` | `gupshup_registration` / "Invalid URL Passed" | `null` / `null` |
| `gupshup.webhookReference` | `null` | `gupshup:account-subscribed` |
| `gupshup.embedSignupUrl` | `null` | `https://gs.tc.im/kZf6e9KQ6mx` |

**`WhatsAppChannel` del tenant: sigue vacío (`[]`) — este es el estado ESPERADO acá, no una falla.** La suscripción a `ACCOUNT_VERIFIED` ya quedó armada y funcionando correctamente; el `WhatsAppChannel` DEDICATED recién se crea (`channelOnboardingCompletion.service.js#handleGupshupAccountVerified()`) cuando alguien complete manualmente el `embedSignupUrl` de arriba (el paso de Gupshup donde se asocia la WABA de verdad) y Gupshup dispare el webhook `ACCOUNT_VERIFIED` hacia la ruta nueva. Ese paso requiere acción humana — no se puede completar solo desde el backend, y su ausencia hoy no indica que algo siga roto.

**Bug cerrado.** Si en el futuro alguien completa ese `embedSignupUrl` y el `WhatsAppChannel` NO se crea (o el webhook `ACCOUNT_VERIFIED` no llega a `/api/v1/webhooks/gupshup/onboarding/:appId`), eso sería un incidente NUEVO — no reabrir esta entrada, documentar aparte con su propia investigación.

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

## 2026-09-04 — Residual de Lovable en `ALLOWED_ORIGINS` (Railway), pendiente de limpiar

**Estado:** Abierto — identificado, no resuelto a propósito (decisión explícita: es config de Railway, no código, lo resuelve el dueño del producto directo en el dashboard cuando quiera).
**Prioridad:** Baja — no rompe nada ni representa un riesgo real (es un string exacto, no un wildcard); es housekeeping.
**Detectado en:** limpieza de referencias a Lovable en `app.js` (CORS), tras confirmar que `esOrigenLovable()`/`SUFIJOS_LOVABLE` ya no tienen ningún uso en el código.
**Archivos/ubicación involucrados:** variable de entorno `ALLOWED_ORIGINS` del servicio `creaos-backend` en Railway (no hay código involucrado).

### Problema

`ALLOWED_ORIGINS` en Railway todavía incluye `https://id-preview--667958fa-039f-4a02-ae9b-171804b126e6.lovable.app` — un preview puntual de cuando el frontend vivía en Lovable. Sacar `esOrigenLovable()`/`SUFIJOS_LOVABLE` del código (limpieza de este mismo PR) no lo afecta: esa entrada es un string exacto dentro de `ALLOWED_ORIGINS`, evaluado por `origenesPermitidos.includes(origin)` — nada que ver con el sufijo wildcard que hacía `esOrigenLovable()`. Sigue siendo un origen válido para CORS hasta que alguien lo saque de la variable.

### Alcance propuesto para el PR de seguimiento

No es un PR — es sacar esa entrada de `ALLOWED_ORIGINS` directo en el dashboard de Railway (`creaos-backend`, variables de entorno), sin tocar código. Cambio de 1 minuto, a criterio del dueño del producto sobre cuándo hacerlo.
