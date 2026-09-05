# Known issues — pendientes de seguimiento

Bitácora de hallazgos reales, fuera del alcance del PR donde se detectaron,
que quedan anotados para retomar como PR aislado más adelante. No confundir
con [`implementation-blueprint.md`](implementation-blueprint.md) (que es el
plan de una migración específica, Fases 0-3 del canal WhatsApp) — este
archivo es de propósito general, para cualquier módulo.

Cada entrada: fecha, estado, prioridad, archivos, problema, alcance
propuesto para el PR de seguimiento.

---

## 2026-09-05 — Piloto PR-11: reintentar el registro en Gupshup tras perder el sessionId chocaba con 409 "Bot Already Exists"

**Estado:** RESUELTO.
**Prioridad:** Alta (bloqueaba completar el onboarding de cualquier tenant que reintentara el flujo más de una vez).
**Detectado en:** segundo tenant de prueba del piloto PR-11 ("Negocio Prueba 2", `+51940766276`) — no relacionado con el incidente de Embedded Signup del 04/sep (entrada anterior), es un bug distinto encontrado en la siguiente sesión de pruebas.
**Archivos involucrados:** [`channel.controller.js`](../../src/modules/channels/channel.controller.js), [`partner.apps.js`](../../src/modules/channels/providers/gupshup/partner/partner.apps.js).

### Problema

El nombre de la app de Gupshup es determinístico por tenant (`nombreAppGupshup(tenantId)`), pero el chequeo `if (!session.gupshup.appId)` en `completeGupshupEmbeddedSignup()` era por SESIÓN, no por tenant. Si el `sessionId` se perdía del lado del frontend (reload, cierre del popup, cualquier interrupción — el `sessionId` vive solo en memoria de React, ver incidente anterior) y el usuario reiniciaba desde `/init`, se creaba una `ChannelOnboardingSession` nueva sin `gupshup.appId` — que no tenía forma de saber que OTRA sesión del mismo tenant ya había creado la app minutos antes. Resultado: `createApp()` se volvía a llamar con el mismo nombre, y Gupshup respondía `409 "Bot Already Exists"`.

Evidencia real: para el tenant "Negocio Prueba 2", la sesión B (creada 05:37:56) completó el registro con éxito (`gupshup.appId: "4f81131f-3b56-4bf5-808f-4e05176d0315"`, confirmado 1:1 contra el Partner Portal de Gupshup) — pero 8 minutos después, la sesión A (un reintento desde cero del mismo tenant) falló con 409 al intentar crear la misma app de nuevo.

### Fix

En `completeGupshupEmbeddedSignup()`, antes de llamar a `createApp()`:
1. **Chequeo a nivel tenant (vía primaria)**: buscar la `ChannelOnboardingSession` más reciente del mismo `tenantId` (excluyendo la actual) con `gupshup.appId` poblado, sin importar su `status` final — el appId en Gupshup sigue siendo válido independientemente de cómo haya terminado esa sesión anterior. Si se encuentra, se reusa directo, sin llamar a Gupshup.
2. **Fallback ante 409 real**: si ninguna sesión en Mongo tenía el appId (ej. el guardado falló después de crear la app en Gupshup pero antes de persistir — mismo patrón "creado afuera, no persistido adentro" del incidente anterior) y `createApp()` responde 409, se resuelve el appId real vía `partnerApps.getPartnerApps()` (nuevo, `GET /partner/account/api/partnerApps`), buscando por el nombre determinístico. Si tampoco aparece ahí, se propaga el 409 original — no se inventa un appId.

**Decisión de diseño**: las sesiones viejas que quedaron en `failed`/`expired` por este motivo NO se marcan de ninguna forma especial ("superseded" u otro estado) — quedan como registro de auditoría tal cual, mismo criterio que el resto de sesiones abandonadas del modelo (nunca se hard-borran ni se reinterpretan). Si en el futuro hace falta distinguir programáticamente "falló pero fue superada" de "falló y quedó sin resolver", la vía más barata sería un campo opcional nuevo (`supersededBySessionId`) en vez de tocar el enum de `status` — no implementado, sin caso de uso real que lo pida todavía.

Tests nuevos: `channel.controller.test.js` (4 tests: reusa appId de otra sesión, usa la más reciente si hay varias, resuelve por `getPartnerApps()` ante 409 sin ninguna sesión con appId, propaga el 409 original si tampoco se encuentra por nombre). `partner.apps.test.js` (`getPartnerApps()`: happy path, respuesta sin `partnerAppsList`, mapeo de error). Suite completa: 302/302.

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

**Estado:** CERRADO — las 4 causas encontradas y corregidas, mergeadas (PR #75, #76, #78) y confirmadas en vivo. `WhatsAppChannel`/`ChannelCredentials` de Nutriva Corp creados y activos. Ver "Cierre del incidente" al final para el resumen completo y por qué la creación final fue manual.
**Prioridad:** Alta (bloqueaba completar un Embedded Signup real de punta a punta) — ya no bloquea, el fix de raíz (PR #78) cubre cualquier Embedded Signup futuro sin intervención manual.
**Detectado en:** primer intento real de Embedded Signup en producción, tenant "Nutriva Corp" (`6a9340ae5af267a3ffd8b1b5`), sesión `6a9ae932fe38b2ca69042e03`, appId de Gupshup `cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4`.
**Archivos involucrados:** [`partner.errors.js`](../../src/modules/channels/providers/gupshup/partner/partner.errors.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js), [`error.middleware.js`](../../src/middleware/error.middleware.js), [`auth.middleware.js`](../../src/middleware/auth.middleware.js), [`channel.controller.js`](../../src/modules/channels/channel.controller.js), [`channelOnboardingWebhook.controller.js`](../../src/modules/channels/channelOnboardingWebhook.controller.js) (nuevo), [`channelOnboardingWebhook.constants.js`](../../src/modules/channels/channelOnboardingWebhook.constants.js) (nuevo), [`channelOnboardingCompletion.service.js`](../../src/modules/channels/channelOnboardingCompletion.service.js), [`webhook.routes.js`](../../src/modules/webhooks/webhook.routes.js), [`client.ts` (crea-os-ignite)](../../../crea-os-ignite/src/lib/api/client.ts).

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

**`WhatsAppChannel` del tenant: sigue vacío (`[]`) — en ese momento se interpretó como el estado ESPERADO** (la suscripción a `ACCOUNT_VERIFIED` había quedado armada correctamente; solo faltaba que alguien completara manualmente el `embedSignupUrl`). Esa lectura resultó incompleta — ver Causa 4.

### Causa 4 (RESUELTA, mergeada Y confirmada en vivo — PR #78) — `meta` doblemente anidado: el header nunca llegó en la entrega real del evento

El usuario completó el `embedSignupUrl` (`https://gs.tc.im/kZf6e9KQ6mx`) del lado de Gupshup con éxito — pero `WhatsAppChannel` siguió vacío y `session.status` nunca pasó a `completed`. Investigado con evidencia, no asumido:

1. **El webhook SÍ llegó.** Log de Railway: `POST /api/v1/webhooks/gupshup/onboarding/cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4 → 401`, con `[channelOnboardingWebhook] request sin credenciales válidas {"headerPresente": false}` — el header `x-gupshup-webhook-secret` no venía en la request real de Gupshup.
2. **Se descartó la hipótesis de 2 WABAs distintas** (el usuario reportó un WABA ID `1447462370887181` en la pantalla de éxito de Gupshup, distinto del `28278663765116123` guardado en la sesión original) como causa del problema: `GET /partner/app/{appId}/subscription` (de solo lectura, sin efectos) confirmó que hay **una única suscripción activa** para `cd6ac9ef-...`, apuntando exactamente a nuestra URL nueva — no hay ninguna suscripción vieja o huérfana recibiendo el evento por su cuenta. (La discrepancia de WABA ID queda sin explicar, pero no es la causa de este bug puntual.)
3. **La causa real estaba en el mismo `GET`**: el campo `meta` de la suscripción activa era `{"headers":{"headers":{"x-gupshup-webhook-secret":"..."}}}` — **un nivel de anidación de más**. Nuestro código armaba `meta = JSON.stringify({ headers })`, siguiendo el ejemplo textual de la documentación de Gupshup (`{"headers":{"X-Gupshup-Webhook-Secret":"..."}}`) — pero ese ejemplo resultó ser el RESULTADO ya envuelto por Gupshup, no el valor a enviar. Gupshup envuelve automáticamente lo que sea que se mande en `meta` dentro de su propio `{"headers": ...}` — mandarlo ya envuelto produce el doble anidado observado, y en la entrega real del evento, Gupshup terminó poniendo un único header literal llamado `headers` (con el JSON de adentro como valor) en vez de `x-gupshup-webhook-secret` — coincide exactamente con el `headerPresente: false` del log.

**Fix:** `partner.subscriptions.js#subscribeToEvents()` ahora manda `meta = JSON.stringify(headers)` directo, sin el wrap extra.

**Cómo se corrige la suscripción YA activa** (no se puede simplemente commitear el fix y esperar — la suscripción con el `meta` malo ya existe en Gupshup): se evaluó volver a llamar `subscribeToEvents()` (POST) con el mismo `tag`, pero la documentación de Gupshup **no aclara** qué pasa al reusar un `tag` ya activo (¿actualiza, rechaza, duplica? — no documentado, riesgo real de romper la suscripción que ya funciona). En su lugar, se agregó `partner.subscriptions.js#updateSubscription()` — `PUT /partner/app/{appId}/subscription/{subscriptionId}` ("Update App Subscription", sí documentado explícitamente para modificar campos puntuales, incluido `meta`, sin tocar el resto), para actualizar la suscripción existente (`id: "10966820"`) por su ID real, sin recrearla.

Tests nuevos/actualizados en `partner.subscriptions.test.js`: `updateSubscription()` (6 tests: happy path, solo manda los campos presentes, sin params no explota, permite pisar url/tag/modes/version/active, mapeo de error 400 "subscription doesn't exist", error no-Gupshup se propaga tal cual) + el test de `meta` de `subscribeToEvents()` actualizado con un guard explícito contra reintroducir el wrap. Suite completa: 295/295.

**Confirmación en vivo post-deploy (mismo día):** PR #78 mergeado → deploy en Railway confirmado exitoso (mismo chequeo de `commitHash` = HEAD de `main`). Ejecutado `updateSubscription('cd6ac9ef-...', apikey, '10966820', { headers: {...} })` contra la suscripción real — la respuesta ya trajo `meta` corregido (`{"headers":{"x-gupshup-webhook-secret":"..."}}`, un solo nivel), confirmado además con un `GET` independiente aparte. `url`/`tag`/`active`/`modes`/`version` de la suscripción quedaron exactamente iguales — la actualización por `id` no tocó nada más, como estaba pensado.

### Cierre del incidente — 05/sep/2026

**Resumen de las 4 causas encontradas y corregidas, en orden:**

| # | Causa | Síntoma | Fix | PR |
|---|---|---|---|---|
| 1 | 401 de Gupshup se reenviaba como "sesión expirada" al usuario | El frontend deslogueaba a mitad del flujo de Embedded Signup | `partner.errors.js` deja de mapear errores de Gupshup a 401 (pasa a 502); `AUTH_SESSION_INVALID_CODE` explícito para diferenciar un 401 real de sesión | #75 |
| 2 | Endpoint de suscripción equivocado (`api.gupshup.io`, tier self-serve) | 401 "Authentication Failed" persistente al suscribirse a eventos ACCOUNT | Endpoint correcto: `partner.gupshup.io` ("Set subscription for an app", pensado para apps sandbox) | #76 |
| 3 | `/api/v1/webhooks/gupshup` exigía un secreto que el ping de verificación de Gupshup no podía conocer | 400 "Invalid URL Passed" al suscribirse | Callback dedicado `/api/v1/webhooks/gupshup/onboarding/:appId`, secreto propio (`GUPSHUP_ONBOARDING_WEBHOOK_TOKEN`), sin tocar el endpoint de producción existente | #76 |
| 4 | `meta` de la suscripción quedaba doblemente anidado | El header custom nunca llegaba en la entrega real del evento — el webhook llegaba pero se rechazaba con 401 | `meta` se manda sin el wrap extra; `updateSubscription()` (PUT) para corregir una suscripción ya activa sin recrearla | #78 |

**Sobre el WABA ID "distinto" (`28278663765116123` vs `1447462370887181`): no es un bug, es esperado.** El primero es el que devolvió el popup de Meta al arrancar el flujo (antes de que Gupshup terminara de procesar la asociación); el segundo es el WABA ID real y definitivo, confirmado independientemente vía `GET /partner/app/{appId}/waba/info` (`accountStatus: "ACTIVE"`, `dockerStatus: "CONNECTED"`) y coincide exactamente con lo que Gupshup le mostró al usuario en su pantalla de éxito. Meta entrega un ID provisorio en el popup inicial; Gupshup confirma el definitivo al completar el embed link. `session.meta.wabaId` quedó con el valor viejo simplemente porque nada en el flujo lo actualiza después de ese primer popup — no hay ninguna corrupción de datos ni 2 WABAs de por medio (confirmado aparte: solo hay una suscripción activa para este app).

**Por qué `WhatsAppChannel`/`ChannelCredentials` de Nutriva Corp se crearon MANUALMENTE, y qué significa (y qué NO significa) eso:**

Para el momento en que se corrigió la Causa 4 (PR #78), el evento `ACCOUNT_VERIFIED` real ya había sido entregado por Gupshup UNA vez y rechazado con 401 (por el bug de la Causa 4, entonces todavía sin corregir) — Gupshup no documenta ningún mecanismo de reintento automático ni de reenvío manual de un webhook ya entregado. Ese evento puntual estaba perdido para siempre. Pero el WABA en sí ya estaba `ACTIVE`/`CONNECTED` del lado de Gupshup (confirmado vía `GET /partner/app/{appId}/waba/info`, de solo lectura) — la verificación había pasado de verdad, solo la notificación nunca nos llegó bien. Se corrigió `session.meta.wabaId` al valor real y se disparó `channelOnboardingCompletion.service.js#handleGupshupAccountVerified('cd6ac9ef-...')` manualmente (mismo código que corre automáticamente ante cualquier webhook real) — resultado: `WhatsAppChannel` (`connectionType: DEDICATED`, `status: active`, `wabaId: "1447462370887181"` correcto) + `ChannelCredentials` (1 apikey cifrada) creados en `6a9b5ff9478f653503523454`/`6a9b5ff9478f653503523456`, sesión en `status: completed`.

**Esto fue una finalización manual de UNA sesión puntual que ya había fallado antes de que el fix existiera — no es un patrón a repetir ni una muleta permanente.** El fix del PR #78 corrige el problema de raíz: cualquier Embedded Signup que se complete DE ACÁ EN ADELANTE va a recibir el webhook `ACCOUNT_VERIFIED` con el header correcto en el primer intento, y `WhatsAppChannel`/`ChannelCredentials` se van a crear automáticamente sin ninguna intervención manual — exactamente como estaba diseñado desde el principio. Si algún Embedded Signup futuro también termina necesitando una finalización manual, eso sería un incidente NUEVO (el mismo bug no puede ser la causa, ya está corregido) — investigar aparte, no asumir que es "lo mismo de siempre".

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
