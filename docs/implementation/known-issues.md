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

## 2026-09-04 — Incidente real de Embedded Signup: 401 de Gupshup deslogueaba al usuario, y la Subscription API rechazó el apikey recién creado

**Estado:** Resuelto en este mismo PR (fix/gupshup-401-mapping-and-subscription-backoff) — se deja esta entrada porque una de las 2 causas (abajo) se corrigió con una HIPÓTESIS NO CONFIRMADA con soporte de Gupshup, para que si vuelve a fallar quien lo investigue tenga el contexto completo sin repetir el diagnóstico desde cero.
**Prioridad:** Alta (bloqueaba completar un Embedded Signup real) — resuelta.
**Detectado en:** primer intento real de Embedded Signup en producción, tenant "Nutriva Corp" (`6a9340ae5af267a3ffd8b1b5`).
**Archivos involucrados:** [`partner.errors.js`](../../src/modules/channels/providers/gupshup/partner/partner.errors.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js), [`error.middleware.js`](../../src/middleware/error.middleware.js), [`auth.middleware.js`](../../src/middleware/auth.middleware.js), [`client.ts` (crea-os-ignite)](../../../crea-os-ignite/src/lib/api/client.ts).

### Problema (2 causas independientes, encadenadas)

1. **`POST /wa/app/{appId}/subscription` (Subscription API de Gupshup) respondió 401** segundos después de que `createApp()` y `GET /partner/app/{appId}/token` devolvieran 200 para la MISMA app recién creada. HIPÓTESIS NO CONFIRMADA CON SOPORTE DE GUPSHUP: la Subscription API (`api.gupshup.io`) y el Partner API de control plane (`partner.gupshup.io`) son sistemas separados — es plausible que el apikey de una app recién creada tarde un momento en propagarse al primero aunque el segundo ya lo reconozca. Mitigado con un backoff progresivo (1s/3s/5s) en `partner.subscriptions.js`, pero no hay confirmación oficial de que esa sea la causa real ni de cuánto puede tardar en el peor caso.
2. **Ese 401 (de Gupshup, nada que ver con la sesión del usuario) se reenviaba tal cual como HTTP 401** al frontend. `apiFetch()` (`client.ts`) trataba CUALQUIER 401 en un endpoint no-auth como "tu sesión expiró": intentaba refrescar el token, reintentaba la petición, volvía a fallar con el mismo 401 (porque el problema era de Gupshup, no del usuario), y deslogueaba a la fuerza. El usuario tuvo que volver a loguearse a mitad del flujo de Embedded Signup.

### Fix aplicado

- `partner.errors.js` ya no mapea ningún error de Gupshup a HTTP 401 — pasa a 502 (mismo criterio que sus 500). Esto por sí solo ya vuelve inequívoco cualquier 401 real del backend (solo lo emite `auth.middleware.js`/`auth.service.js`).
- Además, `AppError` ganó un `code` opcional; `auth.middleware.js` marca sus 401 con `AUTH_SESSION_INVALID_CODE` — señal estructural explícita, no dependiente de que nadie recuerde no volver a mapear un error de tercero a 401 en el futuro.
- `client.ts` solo desloguea/dispara `crea:unauthorized` cuando el 401 trae ese `code` exacto — cualquier otro 401 se trata como un error de negocio normal.
- `partner.subscriptions.js#subscribeToEvents()` reintenta con backoff progresivo (1s, 3s, 5s) únicamente ante un 401 de Gupshup — cualquier otro código (400/403/409/429/500) falla en el primer intento, sin reintentar ciegamente.

### Si vuelve a pasar

Si el backoff de 1s/3s/5s no alcanza (sigue fallando con 401 después de agotar los 3 reintentos), o si Gupshup confirma/descarta la hipótesis de propagación, es en `partner.subscriptions.js` (constante `SUBSCRIPTION_401_RETRY_DELAYS_MS`) donde hay que ajustar — y valdría la pena escalarlo directo con soporte de Gupshup en vez de seguir ajustando delays a ciegas.

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
