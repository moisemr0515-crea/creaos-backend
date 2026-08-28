# Contrato de Meta WhatsApp Embedded Signup — investigación (sin implementar)

**Fecha de esta investigación:** 28 de agosto de 2026.
**Método:** WebFetch/WebSearch contra `developers.facebook.com` (páginas oficiales vigentes) + auditoría del repo. **Ninguna llamada real** a la Graph API de Meta — no hay `META_APP_SECRET` configurado (ver §0), así que esto es puramente documental, igual que se aclaró de entrada.
**Alcance:** insumo para PR-04 del blueprint maestro (`CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md` §21-22, Meta Callback). Este documento **no implementa nada** — es la base para diseñar ese endpoint en una sesión posterior.
**Mismo formato que** `gupshup-partner-api-contract.md`: por operación, marcando qué está confirmado por documentación oficial vs. qué sigue sin probarse en vivo.

---

## 0. Auditoría del repo — ¿qué ya existe?

### `metaOauth.service.js` — qué hace hoy

Archivo: `src/modules/webhooks/metaOauth.service.js`. **Es un flujo de Facebook Lead Ads, no de WhatsApp** — lo usa `webhook.controller.js#metaOauthConnect/Disconnect/Callback` para que un negocio conecte su Página de Facebook y reciba leads de Meta Ads. Nada de esto es WhatsApp/WABA.

Lo que sí es reutilizable como *patrón* (no como código a llamar directo, los scopes/downstream son distintos):

- `exchangeCodeForShortLivedToken(code)`: `GET https://graph.facebook.com/{version}/oauth/access_token?client_id&client_secret&redirect_uri&code` — **mismo endpoint** (`/oauth/access_token`) que necesita el code exchange de Embedded Signup (§3 abajo), aunque con parámetros distintos (Embedded Signup no lleva `redirect_uri`, ver hallazgo del §3).
- `exchangeForLongLivedToken(...)`: exchange adicional específico del flujo de user tokens de Lead Ads (`grant_type=fb_exchange_token`) — **no aplica** a Embedded Signup, cuyo token ya es de otro tipo (system user, ver §3).
- Patrón de `state` vía Redis (`createState`/`consumeState`, TTL 30 min, un solo uso) — directamente reutilizable como *patrón* para el `state` de `ChannelOnboardingSession` (aunque esa pieza ya la resuelve el modelo de PR-01, no Redis).
- `getAuthUrl()` arma una URL de `dialog/oauth` con **redirect completo de página** — este mecanismo **no aplica** a Embedded Signup, que usa un popup vía SDK de JS + `postMessage` (confirmado en §2, no un redirect de página).

### Otro código que habla con la Graph API de Meta

Solo 2 archivos en todo el repo hacen fetch a `graph.facebook.com`:

- `src/modules/webhooks/metaOauth.service.js` (arriba).
- `src/modules/webhooks/webhook.service.js#fetchMetaLead()` — trae datos de un lead de Facebook Ads (`GET /{leadId}?fields=field_data,...`). Tampoco es WhatsApp.

Se buscó explícitamente cualquier uso de `whatsapp_business_account`/`debug_token`/`waba_id` — los únicos matches son el **string literal** `"whatsapp_business_account"` que Meta manda como `object` en el *payload entrante* de los webhooks de mensajería (parseo, no una llamada saliente) en `webhook.service.js`, `webhook.controller.js` y `gupshupProvider.js`. **Cero llamadas salientes** a cualquier endpoint de Graph API relacionado a WABA/número existen hoy en el repo.

**Conclusión: esto es territorio 100% nuevo.** No hay nada que adaptar 1:1, solo el patrón general de `metaOauth.service.js` (fetch a `graph.facebook.com/{version}/...`, manejo de `json.error?.message`).

### Env vars de Meta — estado real (sin exponer valores)

| Variable | ¿Presente? | Detalle |
|---|---|---|
| `META_APP_ID` | ✅ Sí | 16 caracteres |
| `META_APP_SECRET` | ⚠️ Existe la key en `.env` pero **vacía** (`META_APP_SECRET=` sin valor) | No hay forma de hacer un code exchange real hasta que se complete |
| `META_GRAPH_API_VERSION` | Sin setear, usa el default del código (`v19.0`) | — |
| `META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | ❌ No existe | Confirmado — hay que crearla en el dashboard de Meta (ver Gap List) |

**Confirmado: no es posible probar nada de esto en vivo todavía** — falta tanto el `client_secret` real como el `config_id` del flujo de Embedded Signup. Todo lo que sigue es documental.

---

## 1. Disparo del flujo — SDK de JavaScript (frontend, no un endpoint HTTP propio)

No es un endpoint de nuestro backend, pero es parte del contrato porque define qué le llega al callback:

```js
FB.login(callback, {
  config_id: '<META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID>',
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {} },
});
```

- **`config_id`**: exactamente la env var que ya dejamos preparada en PR-03 (`metaConfig.configId` en la respuesta de `init`) — confirmado que es este el valor que el frontend debe pasarle al SDK.
- No se documenta ningún `sessionInfoVersion` como obligatorio para este flujo (sí aparece en integraciones de terceros no oficiales, ej. Dualhook/YCloud — no es parte del contrato oficial confirmado).
- **Fuente**: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- **Confirmado por documentación** — no probado en vivo (no hay `config_id` real todavía).

---

## 2. Entrega de datos al frontend — `postMessage`, CONFIRMADO (no redirect)

Esto estaba asumido en el blueprint anterior pero nunca confirmado contra documentación oficial — **ahora sí está confirmado**: es `postMessage`, no un redirect de página.

**Dos canales distintos, hay que escuchar los dos:**

1. **El `code`** llega vía el callback JS de `FB.login()` (`response.authResponse.code`), no vía `postMessage`.
2. **`wabaId`/`phoneNumberId`/`businessId`** llegan vía un evento `message` separado, escuchado con `window.addEventListener('message', ...)`. Shape exacto documentado:

```json
{
  "data": {
    "phone_number_id": "<ID>",
    "waba_id": "<ID>",
    "business_id": "<ID>"
  },
  "type": "WA_EMBEDDED_SIGNUP",
  "event": "FINISH"
}
```

**Hallazgo importante, no anticipado en el blueprint anterior**: `wabaId` y `phoneNumberId` **no requieren ninguna llamada a la Graph API para resolverse** — Meta se los entrega directo al frontend en este evento. Esto simplifica el diseño original de PR-04: el frontend puede mandarle al backend `{ code, wabaId, phoneNumberId, businessId }` juntos, sin que el backend tenga que "resolverlos" desde el token — solo necesita el `code` para canjear el token y obtener el `phoneNumber` real (E.164, ver §4).

**Restricción crítica de timing**: *"The exchangeable token code has a time-to-live of 30 seconds"* — el code debe llegar al backend y canjearse contra Meta **dentro de 30 segundos** de generado. Esto es un requisito de diseño real para PR-04 (el endpoint de callback no puede depender de ninguna operación lenta antes de canjear el code).

**Fuente**: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
**Confirmado por documentación** — no probado en vivo.

### Evento `CANCEL` — el usuario abandona el popup sin terminar

Confirmado, shape exacto:

```json
{
  "data": { "current_step": "<PANTALLA_DONDE_ABANDONÓ>" },
  "type": "WA_EMBEDDED_SIGNUP",
  "event": "CANCEL",
  "version": 3
}
```

`current_step` es una de: `BUSINESS_ACCOUNT_SELECTION`, `WABA_PHONE_PROFILE_PICKER`, `WHATSAPP_BUSINESS_PROFILE_SETUP`, `PHONE_NUMBER_SETUP`, `PHONE_NUMBER_VERIFICATION`, `PERMISSIONS`. Útil para que el frontend sepa distinguir "todavía no terminó" de "canceló" sin llamar al backend en absoluto — este evento no necesita ni debería disparar ninguna llamada a `POST .../callback`, la sesión simplemente queda `initiated` hasta expirar sola (comportamiento ya cubierto por PR-01/PR-03, nada nuevo que diseñar acá).

**No existe un evento `ERROR` estandarizado** — Meta documenta un catálogo enorme (cientos) de códigos de error que pueden aparecer **dentro del popup mismo** (verificación de negocio, límites de WABA, OTP, 2FA, etc.), pero esos son estados de la UI de Meta que el usuario ve y resuelve (o abandona, generando `CANCEL`) **dentro del iframe de Meta** — no llegan a nuestro backend como un evento aparte, y no hay un shape de "evento de error" documentado más allá de `FINISH`/`CANCEL`. Conclusión práctica: el backend de CREA OS solo necesita manejar `FINISH` y `CANCEL` (o directamente ignorar `CANCEL`, como se explica arriba) — el catálogo de errores de Meta es responsabilidad del lado del popup/frontend, no algo que el callback de PR-04 tenga que catalogar.

**Fuente**: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/errors/
**Confirmado por documentación** — no probado en vivo.

---

## 3. Canje del `code` por un token — CONFIRMADO, mismo endpoint que ya usa `metaOauth.service.js`

| Campo | Valor |
|---|---|
| **Operation** | Canjear el `code` de Embedded Signup por un Business Integration System User access token |
| **HTTP method** | `GET` |
| **Path** | `/oauth/access_token` |
| **Base host** | `https://graph.facebook.com/{META_GRAPH_API_VERSION}` — **mismo host+patrón que ya usa `metaOauth.service.js`** |
| **Authentication** | Ninguna previa — el `client_secret` en query ES la autenticación |
| **Request** | Query params: `client_id` (= `META_APP_ID`), `client_secret` (= `META_APP_SECRET`), `code`. **Sin `redirect_uri`** — a diferencia del flujo de Lead Ads (`metaOauth.service.js`), que sí lo requiere. Esto es coherente con que Embedded Signup no es un redirect de página, no hay una URI de retorno que validar. |
| **Response (200)** | `{ "access_token": "<token>" }` — shape mínimo confirmado, sin campo de expiración en la respuesta (consistente con que el token no expira, ver abajo) |
| **Errors** | No confirmado un catálogo específico para este endpoint puntual — por patrón general de la Graph API (y lo que ya maneja `metaOauth.service.js`), se espera `{ "error": { "message": "..." } }` con un HTTP 4xx |
| **Tipo de token resultante** | **Business Integration System User access token** — confirmado explícitamente, no un user access token común |
| **Expiración** | **"Default a no expirar nunca, para el uso común de comunicación servidor-a-servidor offline"** (cita textual traducida de la doc) — a diferencia del token de `metaOauth.service.js` (60 días, requiere long-lived exchange). **No hace falta ningún segundo canje acá.** |
| **Source documentation** | https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business · https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/ |
| **Last verified** | 2026-08-28 — vía WebFetch sobre ambas páginas oficiales. **No probado en vivo** (falta `META_APP_SECRET` real y un `code` real, que además solo existe 30 segundos). |

**Nota sobre reutilización de `metaOauth.service.js`**: el patrón de `fetch(graph.facebook.com/.../oauth/access_token)` + manejo de `json.error?.message` es directamente reutilizable como *forma*, pero **no es la misma función** — no lleva `redirect_uri`, no hace el segundo exchange a long-lived, y el resultado es un tipo de token distinto. Ver Gap List sobre si conviene extraer un helper común o crear un servicio nuevo.

---

## 4. Resolver el `phoneNumber` en E.164 — necesita 1 llamada adicional

`wabaId`/`phoneNumberId` ya llegan por `postMessage` (§2) — pero el **número de teléfono real** (string E.164) no viene ahí, hace falta pedirlo.

| Campo | Valor |
|---|---|
| **Operation** | Obtener los números de teléfono de una WABA, incluyendo el `display_phone_number` |
| **HTTP method** | `GET` |
| **Path** | `/{WABA_ID}/phone_numbers` |
| **Base host** | `https://graph.facebook.com/{META_GRAPH_API_VERSION}` |
| **Authentication** | Query param `access_token=<token>` (el Business Integration System User token del §3) |
| **Response** | `{ "data": [ { "id", "verified_name", "display_phone_number", "quality_rating" }, ... ], "paging": {...} }` — filtrar `data` por `id === phoneNumberId` (el que ya tenemos del postMessage) para quedarnos con el número correcto si la WABA tiene más de un número. Params opcionales adicionales confirmados: `sort` (`last_onboarded_time_ascending`/descendente) y `filtering` por `account_mode` (`SANDBOX`/`LIVE`, en beta) — ninguno de los dos parece necesario para nuestro caso (ya filtramos por `id` exacto). |
| **Formato de `display_phone_number`** | Confirmado que Meta lo devuelve con espacios/guiones (ej. `"+1 631-555-5556"`), **no E.164 estricto** — hace falta normalizarlo. El repo ya tiene `src/utils/phone.js#normalizeToE164()` (usado hoy por `scripts/seed-whatsapp-channel-platform.js`), reutilizable directo acá. |
| **Source documentation** | https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers |
| **Last verified** | 2026-08-28 — vía WebFetch directo sobre esa página. No probado en vivo. |

---

## 5. Lo que Meta espera que haga el "Tech Provider" — y por qué no aplica 1:1 a CREA OS

La documentación de Embedded Signup es explícita sobre qué debe hacer el Tech Provider después del signup:

> *"You must send this data to your server and use it in a server-to-server call to: exchange the code for a customer-scoped business token; register the customer's business phone number for Cloud API use; subscribe your app to webhooks on the customer's WABA; and share your credit line."*

Los primeros dos ítems de esa lista (canjear el code, y el número/webhooks) están escritos para un Tech Provider que habla **directo con la Cloud API de Meta**. **CREA OS no habla directo con Meta para mensajería — habla con Gupshup, que es el BSP/Tech Provider real ante Meta.** Esto abre una pregunta de diseño real para PR-05 (no PR-04): ¿"registrar el número"/"suscribir webhooks" del lado de Meta lo tiene que hacer CREA OS igual (con su propia Meta App), o eso ya lo cubre Gupshup del lado suyo cuando se le manda `wabaId`/`phoneNumberId` a `obotoembed/whitelist` (PR-02, ya implementado)? **No se encontró nada en la documentación pública de Meta que resuelva esto** — es específico de cómo Gupshup implementó su integración como Tech Provider, no algo que Meta documente en general. Ver Gap List punto 1.

---

## Gap List — qué falta decidir antes de diseñar el endpoint de callback en firme

1. **¿Gupshup necesita el access token de Meta, o solo `wabaId`/`phoneNumberId`?** Esto es la pregunta más importante y no tiene respuesta en la documentación pública de Meta (§5) — es específica de cómo Gupshup consume su rol de Tech Provider. Si Gupshup necesita el token (ej. para su propio `obotoembed/whitelist`), la sesión (`ChannelOnboardingSession.meta.accessTokenCipher`, ya modelado en PR-01) tiene que persistirlo cifrado más allá del canje inicial. Si Gupshup NO lo necesita (resuelve todo por su cuenta con solo `wabaId`/`phoneNumberId`), el token es descartable apenas se usa para resolver el `phoneNumber` (§4) y no hace falta guardarlo. **Sin poder probar esto en vivo, no se puede responder con certeza — es candidato a preguntarle directo a soporte de Gupshup, o a probarlo empíricamente en PR-05 cuando exista una WABA de prueba real.**

2. **`META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` no existe todavía** — confirmado en §0. Hay que crearla en el dashboard de la Meta App de CREA OS (Facebook Login for Business → configuración de Embedded Signup) antes de poder probar cualquier cosa de este documento en vivo. Es un paso manual en el dashboard de Meta, no algo que un PR de código resuelva.

3. **`META_APP_SECRET` está vacío** — confirmado en §0. Sin esto, ni siquiera el canje de code (§3) se puede probar, aunque exista un `code` real.

4. ~~Confianza dispar entre secciones~~ — **resuelto**: se hizo un segundo WebFetch dedicado a `/{WABA_ID}/phone_numbers` (§4), ya no depende solo de un resumen de WebSearch. Las 4 secciones técnicas (§1-4) están respaldadas por WebFetch directo de la página oficial correspondiente.

5. **¿Reusar `metaOauth.service.js` o crear un servicio nuevo?** Son flujos distintos (Lead Ads vs. WhatsApp Embedded Signup) con superposición real solo en la "forma" del fetch a `/oauth/access_token`, no en los parámetros ni en el tipo de token resultante. Extraer un helper genérico de "fetch a graph.facebook.com con manejo de error uniforme" podría tener sentido, pero forzar a `metaOauth.service.js` a servir ambos flujos mezclaría dos productos de Meta completamente distintos (Lead Ads vs. WhatsApp) en el mismo archivo — probablemente mejor un archivo nuevo (ej. `metaEmbeddedSignup.service.js`, como ya se nombraba tentativamente en `fase-2.1-blueprint-final.md` PR 4) que solo comparta el *patrón*, no el código, con `metaOauth.service.js`.

6. **Restricción de los 30 segundos (§2)**: el diseño del endpoint de callback (`POST /api/v1/channels/whatsapp/embedded-signup/callback`, ya bosquejado en `fase-2.1-blueprint-final.md` §4.2) tiene que canjear el `code` inmediatamente al recibirlo, sin ninguna operación lenta antes — esto es una restricción de diseño real que no estaba explícita en el blueprint anterior.

7. **Catálogo de errores del canje de code (§3) sigue sin confirmar puntualmente**: se encontró un catálogo enorme de errores de Embedded Signup (ver §2, evento `CANCEL`), pero esos son errores que ocurren **dentro del popup de Meta** (verificación de negocio, límites de WABA, OTP, 2FA), no errores del endpoint `/oauth/access_token` en sí (`code` vencido a los 30s, reutilizado, o inválido). Para ESE catálogo puntual solo se confirmó el patrón genérico `{error: {message}}` de la Graph API — habría que provocar estos errores en una prueba real (cuando exista `config_id` + `client_secret`) para documentarlos con precisión, igual que se hizo con Gupshup en `gupshup-partner-api-contract.md`.

8. ~~Qué pasa si el usuario cierra el popup sin completar el flujo~~ — **resuelto**: evento `CANCEL` confirmado con shape exacto (§2). Conclusión práctica para el diseño de PR-04: el backend no necesita ni debería reaccionar a `CANCEL` — es una preocupación 100% del frontend, la sesión simplemente expira sola si nunca llega un `FINISH`.
