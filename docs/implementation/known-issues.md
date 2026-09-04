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

## 2026-09-04 — Incidente real de Embedded Signup: 401 de Gupshup deslogueaba al usuario; endpoint de suscripción equivocado; ahora bloqueado por "Invalid URL Passed"

**Estado:** Parcialmente resuelto — 2 de 3 causas encontradas ya tienen fix mergeado o en PR. La 3ra (abajo, "Invalid URL Passed") queda ABIERTA, con evidencia ya reunida para escalar a soporte de Gupshup si hace falta.
**Prioridad:** Alta (bloquea completar un Embedded Signup real de punta a punta).
**Detectado en:** primer intento real de Embedded Signup en producción, tenant "Nutriva Corp" (`6a9340ae5af267a3ffd8b1b5`), sesión `6a9ae932fe38b2ca69042e03`.
**Archivos involucrados:** [`partner.errors.js`](../../src/modules/channels/providers/gupshup/partner/partner.errors.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js), [`error.middleware.js`](../../src/middleware/error.middleware.js), [`auth.middleware.js`](../../src/middleware/auth.middleware.js), [`client.ts` (crea-os-ignite)](../../../crea-os-ignite/src/lib/api/client.ts).

### Causa 1 (RESUELTA, mergeada) — 401 de Gupshup deslogueaba al usuario

Un 401 de Gupshup (nada que ver con la sesión del usuario) se reenviaba tal cual como HTTP 401 al frontend. `apiFetch()` (`client.ts`) trataba CUALQUIER 401 en un endpoint no-auth como "tu sesión expiró" y deslogueaba a la fuerza. Fix: `partner.errors.js` ya no mapea ningún error de Gupshup a 401 (pasa a 502); `AppError` ganó un `code` opcional, `auth.middleware.js` marca sus 401 con `AUTH_SESSION_INVALID_CODE`; `client.ts` solo desloguea si el 401 trae ese código exacto. Mergeado en PR #75.

### Causa 2 (RESUELTA, PR abierto) — endpoint de suscripción equivocado

`POST https://api.gupshup.io/wa/app/{appId}/subscription` (Subscription API "self-serve", tier de mensajería) respondía 401 de forma CONSISTENTE — probado en vivo con backoff de hasta 9s, y hasta horas después del intento original, descartando la hipótesis de "propagación lenta" documentada antes acá. Causa real: ese endpoint es para apps YA live con WABA verificado (como el canal PLATFORM); nuestra app nueva nunca llegó a ese punto. El endpoint correcto es `POST https://partner.gupshup.io/partner/app/{appId}/subscription` ("Set subscription for an app", Partner Portal), con nota textual propia: *"Subscriptions can now be set for sandbox apps as well."* — pensado exactamente para este caso. Fix con header `Authorization` (no `apikey`), `modes` sin corchetes, `version: 3`. Probado en vivo contra la sesión real: **el 401 desapareció** (confirmado, ver Causa 3).

### Causa 3 (ABIERTA) — "Invalid URL Passed"

Con el endpoint corregido, la llamada ya NO da 401 — ahora Gupshup responde `400 {"status":"error","message":"Invalid URL Passed"}` para el campo `url` (nuestro callback: `https://creaos-backend-production.up.railway.app/api/v1/webhooks/gupshup`).

Descartado activamente, probado en vivo contra producción (todas las variantes fallan con el MISMO mensaje):
- No es nuestro dominio: `https://example.com/webhook` (dominio ajeno, genérico, reconocido) falla igual.
- No es el path: la URL sin ningún path (`https://creaos-backend-production.up.railway.app` a secas) falla igual.
- No es encoding: probado tanto con `URLSearchParams` (percent-encoded, `%3A%2F%2F`) como con el body armado a mano sin encodear (`https://` literal) — mismo error en ambos casos.
- No es el `version` (2 vs 3): ambos fallan igual.
- No es form-urlencoded vs JSON: mandar el body como JSON da un error DISTINTO y más específico (`"Required request parameter 'modes' for method parameter type String is not present"`, estilo Spring Boot) — confirma que el endpoint sí espera form-urlencoded (lo que ya mandamos) y que con form-urlencoded correcto, `url`/`tag`/`modes` SÍ se parsean — el rechazo es una validación de negocio sobre el contenido de `url`, no un problema de formato del request.

**Hipótesis no confirmada:** puede ser un prerrequisito no documentado (ej. dominio de callback debe estar pre-registrado/verificado en algún lado del Partner Portal antes de poder suscribirse — similar en espíritu al "Solution ID" que sí hizo falta para otro paso, ver `gupshup-registration-contract.md` §4), o un bug real del lado de Gupshup en su soporte de "sandbox apps" recién anunciado. La documentación pública no menciona nada de esto — el campo `url` solo dice "Should be a valid URL" en su tabla de parámetros.

### Si hace falta escalar a soporte de Gupshup

Ya está toda la evidencia reunida para un ticket concreto: request/response exactos de cada variante probada, confirmación de que el mismo problema ocurre con un dominio ajeno reconocido (`example.com`), y que no es un tema de encoding/formato. Pregunta puntual sugerida: *"Al llamar a `POST /partner/app/{appId}/subscription` (Set subscription for an app) para una app 'sandbox' (sin WABA asociado todavía, siguiendo la nota de que 'subscriptions can now be set for sandbox apps as well'), recibimos 400 'Invalid URL Passed' incluso con `url=https://example.com/webhook` — ¿hay algún prerrequisito de dominio/callback no documentado para este caso?"*

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
