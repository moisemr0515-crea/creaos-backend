# Contrato del Partner API de Gupshup — verificado

**Última verificación:** 28 de agosto de 2026.
**Método de verificación:** consulta a la herramienta "Ask AI" de `partner-docs.gupshup.io` (páginas de referencia individuales de cada endpoint, incluyendo su spec OpenAPI subyacente) + prueba manual real de `POST /partner/account/login` con las credenciales de servidor de CREA OS.
**Regla de ingeniería (blueprint maestro §74):** cuando exista diferencia entre un documento histórico del repo y el Partner Portal vigente, gana el contrato vigente del portal — este documento se actualiza antes de codificar, no al revés.
**Alcance de este documento:** los endpoints que consume `src/modules/channels/providers/gupshup/partner/partner.auth.js` y `partner.apps.js` (PR-02). `partner.customers.js`, `partner.waba.js`, `partner.webhooks.js` y `partner.health.js` quedan para PRs posteriores — cuando se implementen, este documento se extiende, no se reescribe.

---

## ⚠️ Hallazgo importante: el Partner API NO usa un header de auth uniforme

Confirmado en múltiples endpoints: la documentación de Gupshup se contradice a sí misma entre su **tabla de parámetros en prosa** (que en varios endpoints dice `Authorization`) y su **spec OpenAPI** subyacente (que en esos mismos endpoints dice `token`) — la página de "Link App with Partner", por ejemplo, muestra ambas cosas en la misma página.

**Decisión tomada para PR-02**: se usa el header `token` en los 5 endpoints de `partner.apps.js`, por ser lo único consistente en el spec OpenAPI de los 5. Esto **no está confirmado con una llamada real** contra `/partner/app`, `/partner/app/{appId}/onboarding/contact`, `/partner/app/{appId}/obotoembed/whitelist`, `/partner/account/api/appLink` ni `/partner/app/{appId}/obotoembed/verify` — la única llamada real hecha para esta verificación fue el login. **Antes de usar estas funciones contra producción, correr al menos una prueba real de `createApp()` contra el sandbox/cuenta de prueba y confirmar que el header `token` funciona; si Gupshup devuelve 401, el header real es `Authorization` para ese endpoint puntual — corregir ahí y en este documento.**

## ⚠️ Segundo hallazgo: dos endpoints de "embed link" distintos, fácil confundirlos

Gupshup tiene DOS endpoints que generan un link de onboarding, con propósitos distintos:

1. `GET /partner/app/{appId}/onboarding/embed/link` — flujo de onboarding "embed" más viejo, sin relación con el Meta WhatsApp Embedded Signup moderno. Requiere `user`/`lang` como query params, el link dura 5 días. **No es el que usa CREA OS.**
2. `POST /partner/app/{appId}/obotoembed/whitelist` — el real para Meta Embedded Signup ("OBO" = *on-behalf-of*, el modelo de Tech Provider de Meta). Es el que implementa `partner.apps.js#generateEmbedSignupLink()`.

Documentado acá explícitamente porque durante la verificación de este contrato se investigó primero el endpoint (1) por su nombre más obvio ("embed link") antes de confirmar que (2) es el correcto para este caso de uso — un error fácil de repetir si alguien vuelve a tocar este archivo sin leer esta nota primero.

## ⚠️ Tercer hallazgo: el login NO devuelve `expiresIn`

La respuesta real de `POST /partner/account/login` no trae ningún campo de expiración — ni `expiresIn` ni `tokenExpiry`. El "24 horas" de vigencia del token está documentado solo en texto, no en el payload. `partner.auth.js#TOKEN_TTL_SECONDS` es por eso una constante local (23h) del lado de CREA OS, no un valor leído de Gupshup.

---

## 1. Partner Login

| Campo | Valor |
|---|---|
| **Operation** | Autenticación de partner (obtiene el JWT de sesión) |
| **HTTP method** | `POST` |
| **Path** | `/partner/account/login` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Ninguna — este es el propio login |
| **Request** | `Content-Type: application/x-www-form-urlencoded`. Body: `email` (string, requerido), `secret` (string, requerido — client secret configurado en el Partner Portal) |
| **Response (200)** | `{ token, id, name, email, admin, terms_read, billingType, contactName, phoneNumber, activationRead, enableCustomer, enableWallet, enableInrWallet, enableLoaderWallet, isTpp, onboardEnabled }`. **Sin campo de expiración** (ver hallazgo #3 arriba). |
| **Errors** | `403` `{"status":"error","message":"Account Does not exist"}` (cuenta no existe) · `403` `{"status":"error","message":"Failed to authenticate"}` (secret incorrecto) · `500` error interno de Gupshup |
| **Retry policy** | Ninguno automático en `partner.auth.js#login()` (`idempotent:false` — un login es un evento de auditoría del lado de Gupshup, no se reintenta solo) |
| **Idempotency** | No aplica — cada login es un evento nuevo |
| **Sandbox/Live** | Mismo endpoint para ambos; depende de qué cuenta usen las credenciales |
| **Rate limits** | 10 requests / 60 segundos (documentado para toda la familia Partner API) |
| **Source documentation** | https://partner-docs.gupshup.io/reference/post_partner-account-login |
| **Last verified** | 2026-08-28 — **única llamada de esta lista probada realmente en vivo**, con las credenciales de servidor de CREA OS |

---

## 2. Create App

| Campo | Valor |
|---|---|
| **Operation** | Crea una app de Gupshup nueva, pre-linkeada al Partner ID de la cuenta |
| **HTTP method** | `POST` |
| **Path** | `/partner/app` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Header `token` = JWT de partner (ver hallazgo #1 — no confirmado en vivo) |
| **Request** | `Content-Type: application/x-www-form-urlencoded`. Body: `name` (string, requerido, 6-150 caracteres, sin caracteres especiales — charset exacto no documentado con precisión), `templateMessaging` (boolean, opcional, default `false`), `disableOptinPrefUrl` (boolean, opcional) |
| **Response (200)** | `{ appId }` |
| **Errors** | `400` `"Invalid characters used in app name"` · `400` `"App name should be between 6 to 150 characters in length"` · `409` `"Bot Already Exists"` (nombre ya usado — único en TODA la cuenta de Gupshup, no solo CREA OS) · `429` `"Too Many Requests"` · `500` `"Unable to create App"` |
| **Retry policy** | Ninguno (`idempotent:false` en el wrapper) — reintentar un `createApp` ante un 5xx/timeout arriesga crear la app duplicada si el primer intento sí llegó a procesarse del lado de Gupshup |
| **Idempotency** | No hay idempotency key soportada por el endpoint — la única protección real es el 409 por nombre duplicado |
| **Sandbox/Live** | Mismo endpoint para ambos |
| **Rate limits** | 10 requests / 60 segundos |
| **Source documentation** | https://partner-docs.gupshup.io/reference/post_partner-app |
| **Last verified** | 2026-08-28 — vía Ask AI sobre la página de referencia (no probado en vivo) |

---

## 3. Set Contact Details

| Campo | Valor |
|---|---|
| **Operation** | Datos de contacto del negocio durante el onboarding (requeridos por Meta para verificación) |
| **HTTP method** | `PUT` |
| **Path** | `/partner/app/{appId}/onboarding/contact` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Header `token` (confirmado explícitamente como `token`, no `Authorization`, en esta página puntual — la única de las 4 restantes donde el Ask AI no reportó ambigüedad) |
| **Request** | `Content-Type: application/x-www-form-urlencoded`. Body: `contactEmail`, `contactName`, `contactNumber` (los 3, string) |
| **Response (200)** | `{ "status": "success", "message": "contact details updated successfully" }` |
| **Errors** | `400` `"Invalid app id provided"` · `400` `"Please provide valid details"` · `401` `"Authentication Failed"` · `429` `"Too Many Requests"` |
| **Retry policy** | Ninguno (`idempotent:false`) |
| **Idempotency** | El endpoint es naturalmente idempotente en efecto (sobrescribe los mismos 3 campos), pero el wrapper no lo marca como tal para mantener el mismo criterio conservador que el resto de los POST/PUT de este contrato |
| **Sandbox/Live** | Mismo endpoint para ambos |
| **Rate limits** | 10 requests / 60 segundos |
| **Source documentation** | https://partner-docs.gupshup.io/reference/put_partner-app-appid-onboarding-contact |
| **Last verified** | 2026-08-28 — vía Ask AI (no probado en vivo) |

---

## 4. Whitelist WABA ID (generar el link de Embedded Signup)

| Campo | Valor |
|---|---|
| **Operation** | Whitelistea la app para el flujo de Meta Embedded Signup y devuelve el link firmado para el popup de Meta |
| **HTTP method** | `POST` |
| **Path** | `/partner/app/{appId}/obotoembed/whitelist` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Header `token` según spec OpenAPI; la tabla en prosa de esta misma página dice `Authorization` (ver hallazgo #1 — ambigüedad documentada por Gupshup, no nuestra) |
| **Request** | Sin body — solo `appId` en el path |
| **Response (200)** | `{ "embedSignupUrl": "<url firmada>", "id": "<id>", "status": "success" }` |
| **Errors** | `400` `"Error while whitelisting WABA."` · `429` `"Too Many Requests"` · `500` `"Internal Server Error"` |
| **Retry policy** | Ninguno (`idempotent:false`) |
| **Idempotency** | No documentada |
| **Sandbox/Live** | Mismo endpoint para ambos |
| **Rate limits** | 10 requests / 60 segundos |
| **Source documentation** | https://partner-docs.gupshup.io/reference/post_partner-app-appid-obotoembed-whitelist — **no confundir con** https://partner-docs.gupshup.io/reference/get_partner-app-appid-onboarding-embed-link (endpoint distinto, ver hallazgo #2) |
| **Last verified** | 2026-08-28 — vía Ask AI (no probado en vivo) |

---

## 5. Link App with Partner

| Campo | Valor |
|---|---|
| **Operation** | Asocia una app YA EXISTENTE (identificada por su `apiKey`) a la cuenta partner |
| **HTTP method** | `POST` |
| **Path** | `/partner/account/api/appLink` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Header `token` según spec OpenAPI; la tabla en prosa dice `Authorization` (mismo hallazgo #1) |
| **Prerrequisito** | La cuenta partner debe tener MFA habilitado — confirmado que la cuenta de CREA OS lo tiene |
| **Request** | `Content-Type: application/x-www-form-urlencoded`. Body: `apiKey` (string, requerido), `appName` (string, requerido) |
| **Response (200)** | `{ "partnerApps": { "id", "name", "phone", "partnerId", "walletId", "healthy", "live", "stopped", "createdOn", "modifiedOn" } }` |
| **Errors** | `400` Bad request · `401` Unauthorized · `500` Internal server error |
| **Retry policy** | Ninguno (`idempotent:false`) |
| **Idempotency** | No documentada |
| **Sandbox/Live** | Mismo endpoint para ambos |
| **Rate limits** | 10 requests / 60 segundos (asumido, consistente con el resto de la familia — no confirmado puntualmente para este endpoint) |
| **Source documentation** | https://partner-docs.gupshup.io/reference/post_partner-account-api-applink |
| **Last verified** | 2026-08-28 — vía Ask AI (no probado en vivo) |

---

## 6. Verify and Attach Credit Line

| Campo | Valor |
|---|---|
| **Operation** | Último paso del Embedded Signup: verifica la WABA ya whitelisteada y le adjunta la línea de crédito de Gupshup |
| **HTTP method** | `GET` |
| **Path** | `/partner/app/{appId}/obotoembed/verify` |
| **Base host** | `https://partner.gupshup.io` |
| **Authentication** | Header `token` según spec OpenAPI; la tabla en prosa dice `Authorization` (mismo hallazgo #1) |
| **Request** | Sin body — solo `appId` en el path |
| **Response (200)** | `{ "message": "Credit line added successfully for WABA id {waba_id}", "status": "success" }` |
| **Errors** | `400` `"WABA is not migrated to embed yet, ownership type: ON_BEHALF_OF"` (la WABA todavía no completó el paso anterior del lado de Meta) · `400` `"Unable to add credit line for WABA id {waba_id}"` · `429` `"Too Many Requests"` · `500` `"Internal Server Error"` |
| **Retry policy** | Reintenta 5xx/timeout — es un `GET` de solo lectura/verificación, seguro de reintentar (`idempotent: true`, default) |
| **Idempotency** | Sí, por naturaleza (verificar dos veces no duplica nada) |
| **Sandbox/Live** | Mismo endpoint para ambos |
| **Rate limits** | 10 requests / 60 segundos |
| **Source documentation** | https://partner-docs.gupshup.io/reference/get_partner-app-appid-obotoembed-verify |
| **Last verified** | 2026-08-28 — vía Ask AI (no probado en vivo) |

---

## Pendiente antes de ir a producción con estas 6 llamadas

1. Probar en vivo (contra sandbox o la cuenta real de CREA OS) al menos `createApp()` para confirmar el header `token` — es el único punto de este contrato con riesgo real de estar mal, dada la inconsistencia documentada por el propio Gupshup.
2. Confirmar el rate limit de 10 req/60s puntualmente para `appLink` (asumido por consistencia con el resto de la familia, no visto explícito en su página).
3. `partner.customers.js`, `partner.waba.js`, `partner.webhooks.js`, `partner.health.js` — sin investigar todavía, quedan para los PRs que los introduzcan.
