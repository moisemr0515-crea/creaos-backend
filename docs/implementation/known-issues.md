# Known issues — pendientes de seguimiento

Bitácora de hallazgos reales, fuera del alcance del PR donde se detectaron,
que quedan anotados para retomar como PR aislado más adelante. No confundir
con [`implementation-blueprint.md`](implementation-blueprint.md) (que es el
plan de una migración específica, Fases 0-3 del canal WhatsApp) — este
archivo es de propósito general, para cualquier módulo.

Cada entrada: fecha, estado, prioridad, archivos, problema, alcance
propuesto para el PR de seguimiento.

---

## 2026-08-23 — Fuga de revenue: el límite de leads activos nunca se aplicaba, en ningún plan (incluido Starter gratis)

**Estado:** RESUELTO — código implementado con tests, mergeado a `main` el 24/ago/2026 (commit `193b090`, antes de que arrancara esta sesión) + confirmado el 11/sep/2026, con evidencia real de producción, que no había ningún negocio en riesgo al momento de activar el enforcement. Sin pendientes.
**Prioridad:** Crítica — cualquier negocio, incluido el plan Starter gratuito, podía crear leads sin ningún límite.
**Detectado en:** auditoría de pricing del 23/ago/2026 (Track 1), retomado el 11/sep/2026 para diagnóstico y verificación de población real antes de confirmarlo cerrado.
**Archivos involucrados:** [`subscription.service.js#checkLeadLimit()`/`incrementLeadCount()`](../../src/modules/subscriptions/subscription.service.js), [`lead.service.js#crearLead()`/`notifyIfOverLeadLimit()`](../../src/modules/leads/lead.service.js), [`import.service.js`](../../src/modules/imports/import.service.js).

### Problema

`checkLeadLimit()`/`incrementLeadCount()` existían en `subscription.service.js`, pero **ningún camino de creación de leads los llamaba** — ni la creación manual, ni el import CSV/XLSX, ni los automáticos (WhatsApp entrante, automatizaciones). El límite del plan (`Plan.limits.leadsPerMonth`) nunca se aplicaba en la práctica, en ningún plan.

### Fix (ya implementado, PR previo a esta sesión)

`checkLeadLimit()` reescrita para contar leads **activos en vivo** (`Lead.countDocuments`: no borrados, stage que no sea won/lost de ninguno de los pipelines activos del negocio) en vez de depender de `leadsUsedThisMonth` (que `incrementLeadCount()` nunca incrementaba desde ningún caller — se deja sin uso, no se borra, por si sirve a futuro para reporting).

- `lead.service.js#crearLead()` (creación manual) e `import.service.js` (CSV/XLSX): **bloqueo duro** — rechazan con 403 antes de crear si el negocio ya está en el límite.
- `lead.service.js#notifyIfOverLeadLimit()`, para los caminos **automáticos** (WhatsApp entrante, automatizaciones): **fail-soft** a propósito — el lead se crea siempre (nunca se pierde una conversación real de WhatsApp por un límite de plan), pero marca `lead.overQuota = true` y notifica al dueño/asignado del negocio, con cooldown de 24h para no repetir el aviso en cada mensaje nuevo.

Tests: `subscription.service.test.js` (`checkLeadLimit()`/`contarLeadsActivos()`, 7 casos).

### Verificación de población real (11/sep/2026) — sin riesgo al activar

Antes de dar el ítem por cerrado, se corrió un script ad-hoc de solo lectura (`scripts/check-plan-limits-population.js`, reusa `contarLeadsActivos()` tal cual, sin llamar a `getCurrentSubscription()` para no disparar su auto-creación de `Subscription` — sin efectos de escritura) contra **producción** (el usuario lo corrió directamente; este entorno no tiene permiso para ejecutar acciones contra la URI de producción). Resultado: **7 negocios totales, 0 por encima del límite de leads activos de su plan.** El enforcement, ya activo en producción desde el 24/ago, no le cortó el flujo a ningún negocio real.

---

## 2026-08-23 — `inviteUser()` no leía `Business.plan`/`Subscription`: usuarios ilimitados en cualquier plan (Case 3 — `maxUsers`)

**Estado:** RESUELTO — código implementado con tests, mergeado a `main` el 24/ago/2026 (commit `28ba47c`, antes de que arrancara esta sesión) + confirmado el 11/sep/2026, con evidencia real de producción, que no había ningún negocio en riesgo al momento de activar el enforcement. Sin pendientes.
**Prioridad:** Alta — cualquier negocio podía invitar usuarios sin límite, sin importar el plan contratado.
**Detectado en:** auditoría de pricing del 23/ago/2026 (Track 1 #3), retomado el 11/sep/2026 junto con el ítem anterior.
**Archivos involucrados:** [`subscription.service.js#checkUserLimit()`](../../src/modules/subscriptions/subscription.service.js), [`admin.controller.js#inviteUser()`](../../src/modules/admin/admin.controller.js).

### Problema

`inviteUser()` creaba usuarios nuevos sin consultar en ningún momento `Business.plan` ni la `Subscription` del negocio — `Plan.limits.maxUsers` no se aplicaba nunca. Aparte, el número que veía el cliente en la UI de precios (`plan.tsx`, copy estático "1 Usuario"/"1 Usuario"/"3 Usuarios") no tenía ninguna garantía de estar sincronizado con el seed real de `Plan.limits.maxUsers` — eran dos fuentes de verdad independientes.

### Fix (ya implementado, PR previo a esta sesión)

`checkUserLimit()` (nueva, mismo criterio que `checkLeadLimit()`: conteo en vivo de `User.countDocuments({business, isActive:true})`, sin contador denormalizado — liberar cupo, desactivando o borrando un usuario, ya funciona solo). Fallback fail-closed a `1` (el valor real de Starter, el plan más restrictivo) si el `Plan` no está bien poblado.

`admin.controller.js#inviteUser()`: bloqueo duro al principio de la función, antes de cualquier otra validación — rechaza con 403 si el negocio ya está en su límite.

Sobre el copy de `plan.tsx`: verificado el 11/sep/2026 que hoy coincide con el seed real (`plans.seed.js`: Starter=1, Closer=1, Dominator=3 — commit `4a603df chore(plans): baja maxUsers de Closer y Dominator`, ajustó el seed para alinearlo al copy ya existente). No se encontró ninguna pantalla de gestión de equipo/invitar usuarios en `crea-os-ignite` — el copy de `plan.tsx` es la única superficie del frontend que menciona el límite de usuarios hoy.

Tests: `subscription.service.checkUserLimit.test.js` + `admin.controller.inviteUser.test.js`.

### Verificación de población real (11/sep/2026) — sin riesgo al activar, y destraba el Case 3

Mismo script ad-hoc de solo lectura de la entrada anterior (`scripts/check-plan-limits-population.js`), corrido por el usuario contra **producción**. Resultado: de los 7 negocios totales, **0 por encima del límite de usuarios activos de su plan.** Con esto, el Case 3 (`maxUsers`) del backlog queda confirmado como resuelto y sin riesgo — la pregunta pendiente que lo bloqueaba ("¿hay negocios reales ya por encima del límite?") queda contestada por la misma corrida que verificó leads.

---

## 2026-09-10 — `AutomationLog.createdAt` indexado pero nunca poblado (`timestamps:false`)

**Estado:** Abierto — identificado al agregar un índice nuevo al lado (Caso 7 del backlog, PR `feat/automation-time-trigger-model`), no arreglado a propósito: fuera del alcance de ese PR.
**Prioridad:** Baja — el índice no rompe nada ni causa datos incorrectos, simplemente no puede usarse nunca para nada (queda huérfano).
**Detectado en:** revisión de `automation-log.model.js` mientras se agregaba el índice de cooldown para el barrido de triggers de tiempo.
**Archivos involucrados:** [`automation-log.model.js`](../../src/modules/automations/automation-log.model.js).

### Problema

El schema tiene `{ timestamps: false }` (línea 31) — Mongoose nunca agrega ni popula `createdAt`/`updatedAt` en ningún documento de esta colección. Pero la línea 35 tiene `automationLogSchema.index({ business: 1, createdAt: -1 })` — un índice sobre un campo que no existe en ningún documento real. No causa un error (Mongo indexa igual, simplemente todos los valores son "ausentes"), pero el índice es 100% inútil: cualquier query que intente usarlo (`AutomationLog.find({business}).sort({createdAt:-1})`, por ejemplo) no puede aprovecharlo para nada, porque no hay ningún `createdAt` real que ordenar. El campo que sí existe y cumple ese rol es `startedAt` (con default `Date.now`, y ya indexado aparte para el TTL de 90 días).

### Alcance propuesto para el PR de seguimiento

Decisión simple, dos caminos:
- **Borrar el índice muerto** (`{business:1, createdAt:-1}`) si nada depende de él — lo más probable, dado que `createdAt` nunca tiene valor.
- O, si en algún momento se decide que SÍ conviene tener timestamps reales en los logs (auditoría, debugging), activar `{ timestamps: true }` y entonces el índice empieza a tener sentido — pero esto es una decisión de producto/observabilidad, no un fix mecánico.

Cualquiera de los dos es una diferencia de una línea — bajo riesgo, bajo esfuerzo, sin apuro.

---

## 2026-09-06 — Los canales DEDICATED (Embedded Signup) nunca reciben mensajes de WhatsApp entrantes — falta la suscripción `MESSAGE`/`ALL`

**Estado:** RESUELTO — código implementado con tests (PR #85, `fix/gupshup-dedicated-channels-message-subscription`, mergeado y desplegado, incluye el manejo de fallo fail-hard del sub-paso de mensajería, documentado y testeado aparte) + corregidos en producción los 2 canales DEDICATED que ya existían (ver nota al final de esta entrada). Sin pendientes.
**Prioridad:** CRÍTICA — ningún tenant onboardeado vía Embedded Signup (Nutriva Corp, "Negocio Prueba 3", y cualquier tenant futuro) puede recibir mensajes reales de WhatsApp. Gupshup ni siquiera intenta entregárnoslos: no es un fallo silencioso en nuestro código, es una suscripción que nunca se creó.
**Detectado en:** reporte de "ningún lead/conversación nueva" al escribir a 3 números distintos (PLATFORM, Nutriva Corp, "Negocio Prueba 3") — investigado como posible incidente sistémico/infraestructura; descartado eso, la causa es específica y estructural.
**Archivos involucrados:** [`channel.controller.js#completeGupshupEmbeddedSignup()`](../../src/modules/channels/channel.controller.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js).

### Problema

`completeGupshupEmbeddedSignup()` suscribe la app a eventos de Gupshup una sola vez, siempre así ([`channel.controller.js:611-616`](../../src/modules/channels/channel.controller.js#L611)):

```js
await partnerSubscriptions.subscribeToEvents(session.gupshup.appId, apikey, {
  url: `${BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup/onboarding/${session.gupshup.appId}`,
  tag: 'creaos-account-events',
  modes: ['ACCOUNT'],
  headers: { [ONBOARDING_WEBHOOK_HEADER]: GUPSHUP_ONBOARDING_WEBHOOK_TOKEN },
});
```

Esto suscribe **solo** el modo `ACCOUNT` (el evento `ACCOUNT_VERIFIED` que confirma el Go-Live), apuntando al webhook DEDICADO de onboarding (`/api/v1/webhooks/gupshup/onboarding/:appId`, `channelOnboardingWebhook.controller.js`) — nunca al webhook real de mensajería (`/api/v1/webhooks/gupshup`, `webhook.controller.js#gupshupWebhook()`). **En ningún lugar del código se suscribe la app a eventos de mensajería** (`modes` con algo equivalente a `MESSAGE`/`ALL`) apuntando a ese segundo endpoint.

**Evidencia real** — confirmado en vivo contra Gupshup (`GET /partner/app/{appId}/subscription`) para los 2 tenants DEDICATED existentes, cada uno con **una sola suscripción, `modes: ["ACCOUNT"]`**, nada más:

```json
{ "active": true, "tag": "creaos-account-events", "modes": ["ACCOUNT"],
  "url": ".../api/v1/webhooks/gupshup/onboarding/{appId}" }
```

Consistente con esto: la colección `InboundEvent` (creada SOLO cuando `channelResolver.resolve()` encuentra un canal — ver entrada del 05/sep) tiene **cero documentos, en toda su historia**, para el canal de Nutriva Corp o el de "Negocio Prueba 3". No es que el mensaje llegue y se pierda en nuestro pipeline — Gupshup nunca dispara el webhook porque nunca se le pidió que lo hiciera para eventos de mensajería.

El canal PLATFORM (`CREAOS`, self-serve, nunca pasó por Partner API — ver entrada relacionada más abajo sobre el bloqueante de branding) SÍ recibe mensajes con normalidad: su suscripción de mensajería se configuró hace tiempo por fuera de este código (dashboard self-serve de Gupshup, `apps.gupshup.io`), independiente de `subscribeToEvents()`. Por eso el síntoma parecía "sistémico" al probar los 3 números — coincidencia de que el único canal que sí funciona es justo el que no depende de este código.

**Confirmado con el dueño del producto:** Nutriva Corp no tuvo tráfico real de clientes durante el período afectado (solo uso de piloto/pruebas) — no hace falta backfill de datos, no hay nada que recuperar.

### Fix propuesto

**Parte 1 — código, hacia adelante:** en el mismo paso de `completeGupshupEmbeddedSignup()` donde se suscribe `ACCOUNT`, agregar una **segunda suscripción independiente** (mismo `appId`, distinto `tag`, ej. `'creaos-messages'`) con:
- `modes`: cubrir mensajería entrante. **Ojo — no confirmado con certeza cuál es el valor exacto que espera `partner.gupshup.io` para esto** (el propio código de `partner.subscriptions.js:33-36` ya advertía que el vocabulario de este endpoint NO es el mismo que el de la API self-serve vieja, que sí usa literal `MESSAGE`). Antes de implementar, confirmar el valor exacto contra la documentación oficial de Gupshup (`partner-docs.gupshup.io`, "Set subscription for an app") o con el contacto de Partnership (Dali) — candidato más seguro por ahora: `'ALL'` (cubre mensajería entrante + el resto; nuestro `gupshupWebhook()`/`normalizeInboundEvent()` ya ignora silenciosamente cualquier evento que no sea `field: 'messages'`, así que un modo más amplio no tiene downside funcional, solo tráfico extra de webhook).
- `url`: `${BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup` — el endpoint de mensajería real, NO el de onboarding.
- **Deliberadamente NO se toca la suscripción `ACCOUNT` existente** (ni se fusionan los 2 modos en una sola suscripción apuntando a una sola URL) — mezclar mensajería con el endpoint/auth de onboarding (secreto dedicado, `GUPSHUP_ONBOARDING_WEBHOOK_TOKEN`) arriesgaría el flujo de Go-Live ya probado (PR #75/#76/#78/#81/#82/#83) por una ganancia que no hace falta: Gupshup documenta hasta 5 suscripciones por app, así que 2 separadas es el camino compatible con lo ya construido.
- Mismo criterio idempotente que la Causa 2 del incidente del 05/sep (`Duplicate component tag`): chequear con `getSubscriptions()` antes de crear, para que un reintento del mismo paso de onboarding no choque.

**Parte 2 — corrección para los canales DEDICATED ya existentes (Nutriva Corp, "Negocio Prueba 3"):** el fix de código de la Parte 1 solo aplica a onboardings FUTUROS — mismo patrón que el incidente del 05/sep (el fix no es retroactivo). Se necesita un **script de un solo uso** (mismo criterio que `check-*`/`fix-*` de esta sesión) que:
1. Liste los `WhatsAppChannel` existentes con `connectionType: 'DEDICATED'` y `status: 'active'`.
2. Para cada uno, obtenga `apikey` (`getAppAccessToken()`) y llame a `getSubscriptions()` para confirmar que efectivamente falta la suscripción de mensajería (no asumir — otro tenant futuro podría ya tenerla si el fix de código ya está desplegado para onboardings nuevos, y no hay que duplicarla).
3. Si falta, llame a `subscribeToEvents()` con el mismo `modes`/`url`/`tag` de la Parte 1.
4. Reporte antes/después por canal, sin ejecutar nada sin confirmación explícita (mismo protocolo que la corrección manual del `WhatsAppChannel` del 05/sep).

Tests a agregar cuando se implemente: `channel.controller.test.js` (la segunda suscripción se crea junto con `ACCOUNT` en el mismo paso; es idempotente ante reintento — no duplica si ya existe; no rompe ni modifica la suscripción `ACCOUNT` existente). `partner.subscriptions.test.js` ya cubre `subscribeToEvents()`/`getSubscriptions()` en general — no debería necesitar casos nuevos salvo que el modo elegido requiera algún tratamiento especial una vez confirmado contra la documentación real.

### Nota post-implementación — cerrado de punta a punta

**Código (PR #85, mergeado y desplegado):** implementada la segunda suscripción tal como se propuso arriba — `tag: 'creaos-messages'`, `modes: ['ALL']` (confirmado contra la documentación oficial de Gupshup: el endpoint de Partner API no tiene `MESSAGE` en su vocabulario, a diferencia de la API self-serve vieja; `ALL` sí es válido sin restricción de versión), apuntando a `/api/v1/webhooks/gupshup` con el header `x-gupshup-webhook-token` correcto — sin tocar la suscripción `ACCOUNT` ni su webhook dedicado de onboarding. Se agregó además, como discusión aparte antes de implementar, el manejo explícito del camino de fallo: decisión **fail-hard** (si `subscribeToEvents()` de mensajería falla después de que `ACCOUNT` ya tuvo éxito, la sesión queda `failed` pero `webhookReference` de ACCOUNT no se pierde, y un reintento retoma solo el sub-paso que falló, sin duplicar nada) — se descartó fail-soft explícitamente por ser, en los hechos, reproducir el mismo bug silencioso que motivó todo este incidente. 2 tests nuevos cubren ese camino. Suite completa: 321/321.

**Corrección en producción (2026-09-06), aplicada con confirmación explícita en cada paso (dry-run primero, luego `--apply`, luego verificación posterior):** el script `fix-dedicated-channels-missing-message-subscription.js` (de un solo uso, borrado después de usarse) agregó la suscripción de mensajería faltante a los 2 canales DEDICATED que ya existían:

| Tenant | appId | Suscripción creada |
|---|---|---|
| Nutriva Corp | `cd6ac9ef-824a-48cc-ab85-77cb3f21c5c4` | `id: 10968352`, `tag: creaos-messages`, `modes: [ALL]`, `active: true` |
| Negocio Prueba 3 | `4f81131f-3b56-4bf5-808f-4e05176d0315` | `id: 10968353`, `tag: creaos-messages`, `modes: [ALL]`, `active: true` |

Verificado con un dry-run posterior: ambos canales muestran ahora las 2 suscripciones (`creaos-account-events` + `creaos-messages`) activas. No se tocó Mongo en ningún momento — la única fuente de verdad de esta suscripción es Gupshup.

---

## 2026-09-05 — `handleGupshupAccountVerified()` puede completar la sesión EQUIVOCADA cuando hay varios reintentos con el mismo appId

**Estado:** RESUELTO — código implementado con tests (PR #83, `fix/gupshup-account-verified-session-race`, mergeado y desplegado) + corregido en producción el dato ya guardado para "Negocio Prueba 3" (ver nota al final de esta entrada). Sin pendientes.
**Prioridad:** Alta — crea un `WhatsAppChannel` real con el número de teléfono/WABA equivocado, silenciosamente (sin error, `status: 'completed'`).
**Detectado en:** piloto PR-11, "Negocio Prueba 2" — el tenant reintentó el Embedded Signup varias veces a lo largo del día (fixes de PR #81/#82 funcionando correctamente, reusando el mismo `gupshup.appId` en cada intento). El primer intento de la mañana usó el número `+51940766276` (quedó sin completar — "App is not live"); un intento posterior, ya de tarde, usó un número distinto, `+51967424911` ("Negocio Prueba 3"), y ese sí llegó a verificarse del lado de Gupshup.
**Archivos involucrados:** [`channelOnboardingCompletion.service.js#handleGupshupAccountVerified()`](../../src/modules/channels/channelOnboardingCompletion.service.js), [`partner.apps.js`](../../src/modules/channels/providers/gupshup/partner/partner.apps.js).

### Problema

`handleGupshupAccountVerified(gsAppId)` reclama la sesión a completar así:

```js
const session = await ChannelOnboardingSession.findOneAndUpdate(
  { 'gupshup.appId': gsAppId, status: 'gupshup_registering' },
  { $set: { status: 'completing' } },
  { new: true }
);
```

**Sin ningún `sort`.** Los fixes de PR #81/#82 (reutilización de `appId`/`webhookReference` entre sesiones del mismo tenant) hicieron normal y esperado que **más de una** `ChannelOnboardingSession` del mismo tenant comparta el mismo `gupshup.appId` y esté simultáneamente en `status: 'gupshup_registering'` — algo que antes de esos fixes no pasaba nunca. Cuando el webhook `ACCOUNT_VERIFIED` llega y esa query matchea más de un documento, Mongo devuelve el primero según su orden interno (en la práctica, el más viejo) — **no necesariamente la sesión que corresponde al intento que realmente se verificó.**

**Evidencia real:** el `WhatsAppChannel` que se creó hoy a las 17:43 quedó con `phoneNumber: "+51940766276"` / `wabaId: "1605050847659677"` (los datos de la sesión más VIEJA, de las 05:37) — pero `GET /partner/app/{appId}/waba/info` (fuente de verdad de Gupshup, consultada en vivo) confirma que el número real y verificado es `+51967424911` / `wabaId: "1709122084547289"` ("Negocio Prueba 3"). El canal se creó silenciosamente con datos de un intento distinto al que realmente se completó — sin ningún error, `session.status` quedó en `'completed'` igual.

Esto es la MISMA familia de problema que el `wabaId` obsoleto de Nutriva Corp (Meta entrega un WABA provisorio en el popup inicial, Gupshup confirma uno definitivo al completar) — pero ahí fue una corrección manual puntual porque solo había 1 sesión candidata. Acá el mismo fenómeno se combina con **múltiples sesiones candidatas**, y el resultado es silenciosamente peor: el canal queda con el número de un intento que ni siquiera es el que se verificó.

### Fix propuesto

Dos cambios, complementarios — el primero mitiga, el segundo elimina la causa de raíz:

1. **`sort: { createdAt: -1 }` en el `findOneAndUpdate`** — ante varias sesiones candidatas, reclamar la más reciente (mismo criterio "más reciente gana" ya usado en los fixes de PR #81/#82). No es la solución completa por sí sola (la más reciente tampoco está garantizado que sea la que Gupshup efectivamente verificó), pero es una mejora barata y sin downside.

2. **No confiar en `session.meta.phoneNumber`/`phoneNumberId`/`wabaId` para crear el `WhatsAppChannel`** — esos son datos de Meta, cacheados en el momento en que ESA sesión puntual completó su propio popup, y pueden quedar obsoletos o pertenecer a un intento distinto (exactamente lo que pasó acá). En su lugar, en el momento de completar (ya se tiene `apikey` de `getAppAccessToken()`, disponible ahí mismo), consultar `GET /partner/app/{appId}/waba/info` — la fuente de verdad de Gupshup sobre CUÁL es el número/WABA real y verificado para ese `appId`, independientemente de qué sesión haya quedado reclamada. Requiere una función nueva en `partner.apps.js` (ej. `getWabaInfo(appId, apikey)`) — mismo patrón que `getPartnerApps()`/`getSubscriptions()` de fixes anteriores. Ojo con el shape de la respuesta real (confirmado en vivo): `{"phone":"51967424911","phoneId":"1261899130346864","wabaId":"...",...}` — el campo es `phoneId`, no `phoneNumberId`, y `phone` viene sin el `+` inicial.

Con el punto 2 implementado, el punto 1 deja de ser crítico (la sesión reclamada solo aporta `tenantId` — igual entre todas las candidatas del mismo tenant/appId — y sirve para marcar `status: 'completed'`/`session.channel`; el dato real del canal sale de Gupshup, no de la sesión) pero se mantiene igual como buena práctica.

Tests a agregar cuando se implemente: `channelOnboardingCompletion.service.test.js` (usa `getWabaInfo()` en vez de `session.meta` para poblar el canal; con 2+ sesiones candidatas reclama la más reciente); `partner.apps.test.js` (`getWabaInfo()`: happy path con el shape real de la respuesta, mapeo de error, caso "App is not live").

### Nota post-implementación — "Negocio Prueba 3": corregido en producción

El fix (`fix/gupshup-account-verified-session-race`, PR #83) corrige el comportamiento HACIA ADELANTE — el próximo webhook `ACCOUNT_VERIFIED` que llegue va a reclamar la sesión correcta (punto 1) y va a poblar el canal con el dato real de Gupshup en vez del de `session.meta` (punto 2). No corregía retroactivamente el `WhatsAppChannel` que ya había quedado mal guardado para "Negocio Prueba 3" — Gupshup entrega el webhook una sola vez por evento de verificación (ya se había consumido), así que no había ningún webhook nuevo que fuera a reprocesar esa sesión puntual.

**Corrección manual aplicada en producción el 2026-09-06**, con confirmación explícita antes y después de tocar la base: se leyó el documento actual + se consultó `getWabaInfo()` en vivo para confirmar el dato real (`accountStatus: ACTIVE`, `phone: 51967424911`, `wabaId: 1709122084547289` — coincidía con lo esperado), y luego se actualizó el `WhatsAppChannel` existente (`_id: 6a9c54b00aa43d1b1c51fb9c`, tenant "Negocio Prueba 2") vía `updateOne()` puntual sobre esos 3 campos únicamente:

| Campo | Antes | Después |
|---|---|---|
| `phoneNumber` | `+51940766276` | `+51967424911` |
| `phoneNumberId` | `1290757037455647` | `1261899130346864` |
| `wabaId` | `1605050847659677` | `1709122084547289` |

No se tocó `ChannelOnboardingSession` (ya estaba `'completed'`, no bloqueaba nada) ni las credenciales (el `apikey` guardado seguía siendo válido, es de la app, no del número). Scripts de un solo uso, borrados después de usarse — mismo criterio que el resto de esta entrada.

---

## 2026-09-05 — Piloto PR-11: reintentar el onboarding tras perder el sessionId chocaba con 409 "Bot Already Exists" y luego con 400 "Duplicate component tag"

**Estado:** RESUELTO — 2 causas, mismo patrón, mismo `completeGupshupEmbeddedSignup()`.
**Prioridad:** Alta (bloqueaba completar el onboarding de cualquier tenant que reintentara el flujo más de una vez).
**Detectado en:** segundo tenant de prueba del piloto PR-11 ("Negocio Prueba 2", `+51940766276`) — no relacionado con el incidente de Embedded Signup del 04/sep (entrada anterior), son bugs distintos encontrados en la siguiente sesión de pruebas.
**Archivos involucrados:** [`channel.controller.js`](../../src/modules/channels/channel.controller.js), [`partner.apps.js`](../../src/modules/channels/providers/gupshup/partner/partner.apps.js), [`partner.subscriptions.js`](../../src/modules/channels/providers/gupshup/partner/partner.subscriptions.js).

### Causa 1 (RESUELTA) — `createApp()`: 409 "Bot Already Exists"

El nombre de la app de Gupshup es determinístico por tenant (`nombreAppGupshup(tenantId)`), pero el chequeo `if (!session.gupshup.appId)` en `completeGupshupEmbeddedSignup()` era por SESIÓN, no por tenant. Si el `sessionId` se perdía del lado del frontend (reload, cierre del popup, cualquier interrupción — el `sessionId` vive solo en memoria de React, ver incidente anterior) y el usuario reiniciaba desde `/init`, se creaba una `ChannelOnboardingSession` nueva sin `gupshup.appId` — que no tenía forma de saber que OTRA sesión del mismo tenant ya había creado la app minutos antes. Resultado: `createApp()` se volvía a llamar con el mismo nombre, y Gupshup respondía `409 "Bot Already Exists"`.

Evidencia real: para el tenant "Negocio Prueba 2", la sesión B (creada 05:37:56) completó el registro con éxito (`gupshup.appId: "4f81131f-3b56-4bf5-808f-4e05176d0315"`, confirmado 1:1 contra el Partner Portal de Gupshup) — pero 8 minutos después, la sesión A (un reintento desde cero del mismo tenant) falló con 409 al intentar crear la misma app de nuevo.

**Fix**, antes de llamar a `createApp()`:
1. **Chequeo a nivel tenant (vía primaria)**: buscar la `ChannelOnboardingSession` más reciente del mismo `tenantId` (excluyendo la actual) con `gupshup.appId` poblado, sin importar su `status` final — el appId en Gupshup sigue siendo válido independientemente de cómo haya terminado esa sesión anterior. Si se encuentra, se reusa directo, sin llamar a Gupshup.
2. **Fallback ante 409 real**: si ninguna sesión en Mongo tenía el appId (ej. el guardado falló después de crear la app en Gupshup pero antes de persistir — mismo patrón "creado afuera, no persistido adentro" del incidente anterior) y `createApp()` responde 409, se resuelve el appId real vía `partnerApps.getPartnerApps()` (nuevo, `GET /partner/account/api/partnerApps`), buscando por el nombre determinístico. Si tampoco aparece ahí, se propaga el 409 original — no se inventa un appId.

### Causa 2 (RESUELTA) — `subscribeToEvents()`: 400 "Duplicate component tag"

Con la Causa 1 arreglada (el `appId` ya se reusaba bien), apareció el mismo problema un paso más adelante: `if (!session.gupshup.webhookReference)` también era por SESIÓN, no por tenant+appId. La app reusada (creada por la sesión B) ya tenía una suscripción activa con el `tag` determinístico (`'creaos-account-events'`) — confirmado en vivo (`GET /partner/app/{appId}/subscription`, solo lectura): `{"id":"10967130","active":true,"tag":"creaos-account-events",...}`, con la URL y el `meta` ya correctos. La sesión A, sin saberlo, volvía a llamar `subscribeToEvents()` (POST, crear) con el mismo `tag` → Gupshup respondía `400 "Duplicate component tag. Please ensure that each tag is unique."`.

**Fix**, mismo patrón exacto que la Causa 1, un nivel más abajo:
1. **Chequeo a nivel tenant+appId (vía primaria)**: buscar otra `ChannelOnboardingSession` del mismo `tenantId` **con el mismo `gupshup.appId`** que tenga `webhookReference` poblado. Si existe, se copia el marcador directo, sin llamar a Gupshup.
2. **Fallback ante Gupshup**: si ninguna sesión en Mongo lo tenía, se consulta `partnerSubscriptions.getSubscriptions()` (nuevo, `GET /partner/app/{appId}/subscription`) buscando una suscripción `active` con ese `tag`. Si aparece, se marca directo (ya estaba bien configurada, no hace falta `updateSubscription()` acá). Si tampoco aparece, recién ahí se llama a `subscribeToEvents()` (POST) como siempre.

**Decisión de diseño (aplica a ambas causas)**: las sesiones viejas que quedaron en `failed`/`expired` por este motivo NO se marcan de ninguna forma especial ("superseded" u otro estado) — quedan como registro de auditoría tal cual, mismo criterio que el resto de sesiones abandonadas del modelo (nunca se hard-borran ni se reinterpretan). Si en el futuro hace falta distinguir programáticamente "falló pero fue superada" de "falló y quedó sin resolver", la vía más barata sería un campo opcional nuevo (`supersededBySessionId`) en vez de tocar el enum de `status` — no implementado, sin caso de uso real que lo pida todavía.

Tests nuevos: `channel.controller.test.js` (Causa 1: 4 tests — reusa appId de otra sesión, usa la más reciente si hay varias, resuelve por `getPartnerApps()` ante 409 sin ninguna sesión con appId, propaga el 409 original si tampoco se encuentra por nombre. Causa 2: 4 tests — reusa webhookReference de otra sesión con el MISMO appId, NO lo reusa si el appId es distinto, resuelve por `getSubscriptions()` ante ninguna sesión con webhookReference, sigue con `subscribeToEvents()` sin regresión si `getSubscriptions()` no encuentra el tag). `partner.apps.test.js` (`getPartnerApps()`: happy path, sin `partnerAppsList`, mapeo de error). `partner.subscriptions.test.js` (`getSubscriptions()`: happy path, sin `subscriptions`, mapeo de error, error no-Gupshup se propaga tal cual). Suite completa: 312/312.

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

**Estado:** Resuelto parcialmente (09/sep/2026) — "Personalidad" cableada de punta a punta (Business.aiPersonality + allowlist + bloque condicional en `buildSystemPrompt()`, creaos-backend PR #94; guardado movido a `updateCurrentBusiness()` en `business.tsx`, crea-os-ignite). "Nivel" NO se cableó — sigue oculto en la UI a propósito (bloque comentado en `business.tsx`, crea-os-ignite PR #19) porque "Cierre automático" necesita el guardrail de `update_lead_stage` (ver entrada del 2026-09-10 más abajo, Caso 5/7) que todavía no existe.
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

## 2026-09-10 — "Seguimiento automático" / "Cierre asistido por IA" (panel de negocio y precios): placeholder en 3 capas, y además anunciado como feature de un plan pago

**Estado:** RESUELTO (11/sep/2026) — las 3 capas diagnosticadas acá (persistencia rota, automatización real desconectada, sin trigger de tiempo) quedaron cerradas de punta a punta con lógica real: WhatsApp real vía `send_template`, umbral configurable, semilla cableada + migración para negocios ya sembrados, y UI real (toggle, umbral, selector de plantilla) — 6 PRs, blueprint aprobado antes de escribir código, mergeados a `main` en ambos repos y verificados con evidencia. Ver "Cierre — fix de fondo implementado" al final de esta entrada.
**Prioridad:** Alta — a diferencia de "Nivel"/"Personalidad", esto también se vendía como feature incluida en el plan Closer (`plan.tsx`), no solo un toggle de configuración interna.
**Detectado en:** backlog Caso 5, auditado a fondo el 09/sep/2026 (mismo ciclo que Casos #12/#15 de leads).
**Archivos involucrados:** [`automation.service.js`](../../src/modules/automations/automation.service.js) (seed + toggle real), [`automation.engine.js#triggerAutomations()`](../../src/modules/automations/automation.engine.js), [`automation.model.js#TRIGGER_TYPES`](../../src/modules/automations/automation.model.js), [`user.controller.js#updateMiPerfil()`](../../src/modules/users/user.controller.js), [`business.tsx`](../../../crea-os-ignite/src/routes/business.tsx) y [`plan.tsx`](../../../crea-os-ignite/src/routes/plan.tsx) (frontend), [`lib/api/automations.ts`](../../../crea-os-ignite/src/lib/api/automations.ts).

### Problema

Tres fallas independientes apiladas, no una sola:

**1. El toggle de `business.tsx` no persiste — mismo bug de ruteo que Nivel/Personalidad.** `auto_followup_enabled`/`auto_close_enabled` no existen en ningún modelo del backend (ni `Business.model.js` ni `User.model.js`) y viajan por `save()`/`updateMe()` → `PUT /api/v1/users/me`, que solo persiste `{name, phone, avatar}` — sin validador Joi, así que la request nunca falla: 200 OK, toast "Cambios guardados", y no se guarda nada. Peor que el bug de temperatura en Leads (que sí devuelve 400): acá el usuario ve éxito falso.

**2. Aunque persistiera, no tocaría la automatización real — son dos modelos de datos desconectados.** El backend SÍ tiene un CRUD completo y funcional de automatizaciones (`automation.service.js`: `createAutomation`, `toggleActive`, `verificarLimiteAutomatizaciones` con enforcement real de plan, endpoints `PATCH /automations/:id/toggle`, `GET /automations/limit`). Se siembran 2 automatizaciones reales por negocio (`AUTOMATIZACIONES_SEMILLA`, `automation.service.js:80-97`, `type:'followup'`/`type:'auto_close'`). Pero **nada en el frontend llama a `toggleAutomation()`** (`lib/api/automations.ts:55-60`) — no existe una pantalla `/automations`. La única función de esa API que se usa es `getAutomationLimit()`, y solo para calcular el candado de plan del toggle roto de arriba — un mecanismo real, reusado para gatear una función que no existe.

**3. Aunque se conectaran las capas 1 y 2, seguiría sin ejecutar nada — bloqueado por el Caso 7.** Las automatizaciones semilla tienen `trigger: { type: 'manual' }` (`automation.service.js:86,94`). `triggerAutomations()` (`automation.engine.js:320-339`) solo dispara automatizaciones cuyo `trigger.type` matchea un evento real (`lead_created`, `lead_assigned`, `lead_stage_changed`) — nunca se invoca con `'manual'`. La única forma de ejecutar una automatización `manual` es el endpoint de test explícito (`testAutomation()`, un lead a la vez). `TRIGGER_TYPES` (`automation.model.js:3-11`) no tiene ningún trigger de tiempo/cron — y "seguimiento a los N días sin contacto" / "cierre cuando hay señales de inactividad" son, por definición, condiciones de tiempo. Esto es el Caso 7 del backlog: el motor de automatizaciones no soporta trigger por tiempo, solo por evento.

**Hallazgo adicional, fuera del alcance original del caso:** el texto exacto "Seguimiento automático" / "Cierre asistido por IA" aparecía en `plan.tsx` como feature incluida del plan Closer (pago) — no solo un toggle de configuración. Un negocio que paga específicamente por esta línea de la comparación de planes no recibe ningún comportamiento real, sin importar cuánto pague.

### Decisión implementada (09/sep/2026)

- **`business.tsx`:** todo el bloque "Automatizaciones" (los 2 `AutomationToggle`, su estado, el fetch de `getAutomationLimit()`, y el modal de upgrade asociado) queda comentado, no borrado — mismo patrón que "Nivel". Documentado inline por qué (bloqueado por este mismo hallazgo, Caso 7).
- **`plan.tsx`:** "Seguimiento automático" y "Cierre asistido por IA" se movieron de `features` (check verde, "incluido") a un nuevo `comingSoon` (ícono de reloj, "Próximamente") en la card de Closer — decisión ya tomada en la auditoría de pricing de agosto (Track 2), pendiente de ejecución hasta ahora.

### Decisión pendiente — el fix de fondo depende del Caso 7

No alcanza con cablear el toggle a la automatización real (capas 1+2): sin resolver primero el Caso 7 (agregar un trigger por tiempo/cron al motor de automatizaciones — `automation.model.js#TRIGGER_TYPES` + un scheduler que lo dispare periódicamente), la automatización seguiría sin ejecutar nada real aunque el toggle "funcionara". El desarrollo real, una vez resuelto el Caso 7, todavía requiere definir la lógica de negocio concreta: qué es "un lead sin seguimiento hace N días" y qué señales ameritan proponer un cierre. Queda documentado para retomar junto con el Caso 7.

### Cierre — fix de fondo implementado (11/sep/2026)

Con el Caso 7 resuelto (motor de triggers de tiempo — `lead_stale`/`stage_stalled`, workers de barrido/ejecución vía BullMQ, PRs `feat/automation-time-trigger-model`, `feat/automation-time-triggers-registry`, `feat/automation-sweep-worker`), se retomó y cerró este caso. Decisiones de producto confirmadas explícitamente antes de escribir código: "Seguimiento automático" v1 manda un mensaje real de WhatsApp (no solo una notificación interna), respetando la ventana de 24h; el umbral de días es configurable por el usuario en la UI (ya no hardcodeado); "Cierre automático" ejecuta `change_stage` sin gate humano (a diferencia de "Nivel", que sigue oculto — ver entrada del 24/ago); y un script de migración cubre los negocios que ya tenían las automatizaciones semilla sembradas con el shape viejo (`trigger.type:'manual'`, congelado para siempre por el `$setOnInsert` del seed).

6 PRs, blueprint completo aprobado antes de empezar, en orden de dependencia — los 4 primeros de `creaos-backend`, los 2 últimos de `crea-os-ignite`, todos mergeados a `main` y verificados con evidencia real (`git branch -r --merged origin/main` + hash de commit, no por memoria de conversación):

| PR | Qué resuelve | Commit | Merge |
|---|---|---|---|
| A — `feat/automation-send-template-action` | Acción real `send_template` en el motor (`automation.engine.js`) — WhatsApp real vía `channelService`, respeta la ventana de 24h (texto libre si está abierta, plantilla si está cerrada), deliberadamente NO toca `conversation.aiEnabled` (una automatización no es un agente humano "tomando control") | `e7b516b` | #98 |
| B — `feat/automation-stage-stalled-notification` | Guardrail: notificación interna + push al usuario asignado cuando el trigger `stage_stalled` ejecuta `change_stage` con éxito — acotado a ese trigger, no se filtra a `change_stage` en general | `030c7f1` | #99 |
| C — `feat/automation-seed-real-triggers` | Semilla (`AUTOMATIZACIONES_SEMILLA`) cableada a triggers/acciones reales (`lead_stale`/`stage_stalled`, ya no `manual`) — resuelve la etapa "ganada" real de cada negocio vía `pipelineService`, salteando y logueando (sin bloquear al resto) el negocio que no tenga ninguna | `7de8c43` | #100 |
| D — `feat/automation-seed-migration` | Script de migración de un solo uso (`scripts/migrate-automation-seeds-real-triggers.js`) para negocios que ya tenían las 2 automatizaciones semilla sembradas con el shape viejo — preserva name/description editados a mano, mismo criterio "saltear y loguear" del PR C, idempotente | `da59317` | #101 |
| E1 — `feat/automation-toggle-real-wiring` | UI real en `business.tsx`: toggle (`isActive`, `PATCH /automations/:id/toggle`) + umbral de días (`trigger.conditions`, `PATCH /automations/:id`) contra el `Automation` real del negocio — ya no el booleano fake `Profile.auto_followup_enabled`/`auto_close_enabled` (descartado en silencio por `PUT /users/me`, causa raíz original de este hallazgo) | `ddffb5a` | #23 (crea-os-ignite) |
| E2 — `feat/automation-template-picker` | Selector real de plantilla de WhatsApp para "Seguimientos automáticos" (única automatización con acción `send_template`) — solo lista plantillas aprobadas SIN variables (`{{...}}`); completar variables queda fuera de v1 a propósito, sin UI para eso todavía | `f0348eb` | #24 (crea-os-ignite) |

Verificación: suite completa de `creaos-backend` en 467/467 (48 suites) al cierre del PR D. `crea-os-ignite` no tiene test runner de frontend — verificación vía `tsc --noEmit` + `eslint` (sin hallazgos reales, filtrando el ruido preexistente de `prettier/prettier` por CRLF de Windows) en cada uno de E1/E2.

**Fuera de alcance de v1, a propósito (no es deuda oculta):** completar variables de plantilla (`{{1}}`, etc.) en "Seguimientos automáticos" — las plantillas con variables se excluyen del selector hasta que exista esa UI, decisión explícita del usuario al aprobar el PR E2.

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
