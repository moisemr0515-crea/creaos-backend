# Contrato de registro de WABA en Gupshup — investigación (sin implementar)

**Fecha de esta investigación:** 28 de agosto de 2026.
**Método:** auditoría del repo + WebFetch/WebSearch contra `partner-docs.gupshup.io` + interacción real con el widget **Ask AI** de Gupshup (vía browser, sin necesitar login) + intentos (bloqueados) contra `support.gupshup.io`.
**Alcance:** insumo para desbloquear el diseño de PR-05 (Gupshup Registration) del blueprint maestro. **No implementa nada** — es investigación pura, ningún archivo de código fue tocado.
**Pregunta original a responder:** ¿`POST /partner/app/{appId}/obotoembed/whitelist` necesita el access token de Meta (el que ya obtenemos y ciframos en PR-04), o le alcanza con `wabaId`/`phoneNumberId`?

**Adelanto del resultado**: la pregunta original quedó respondida con alta confianza (**NO necesita nada de eso**, ver §2) — pero la investigación encontró algo más importante y no anticipado: **hay evidencia real de que `obotoembed/whitelist`/`verify` (los endpoints que ya implementó PR-02) podrían no ser los correctos para el caso de CREA OS.** Ver §3, marcado como el hallazgo más importante de este documento.

**✅ ACTUALIZACIÓN — gap cerrado con fuentes directas (ver §9)**: la contradicción de §3/§6 quedó resuelta, ya no por interpretación de IA sino por confirmación escrita de un contacto humano de Gupshup (Dali) + verificación directa en el propio Partner Portal. Conclusión: **`GET /partner/app/{appId}/onboarding/embed/link` (Generate Embed Signed Link) es el endpoint correcto para altas nuevas. `obotoembed/whitelist`/`verify` (PR-02) quedan reservados para un futuro caso de migración — no se usan en el flujo principal de PR-05.** Ver §9 para el detalle completo con las 3 fuentes.

---

## 0. Auditoría del código y contrato ya existentes en el repo

### Código (`src/modules/channels/providers/gupshup/partner/*.js`)

- **`gupshup.http.client.js`**: cliente HTTP base, sin lógica de negocio — nada que auditar en relación a esta pregunta.
- **`partner.auth.js`**: `login()`/`getValidToken()` — resuelve el JWT de partner de Gupshup, no tiene relación con el access token de *Meta* (son dos tokens completamente distintos, de dos proveedores distintos — esto ya estaba claro pero vale la pena decirlo explícito para no confundirlos en el diseño de PR-05).
- **`partner.apps.js#generateEmbedSignupLink(appId, token)`**: implementa `POST /partner/app/{appId}/obotoembed/whitelist` — **sin ningún parámetro además de `appId` y el token de partner**. Ni el código ni su JSDoc contemplan pasar nada relacionado a Meta (token, wabaId, phoneNumberId). Esto ya era consistente con lo que se terminó confirmando (§2) — pero ver §3 sobre si esta función llama al endpoint correcto en absoluto.
- **`partner.apps.js#verifyAndAttachCreditLine(appId, token)`**: `GET /partner/app/{appId}/obotoembed/verify` — mismo patrón, solo `appId`.
- **`partner.errors.js`**: catálogo de errores, sin relación directa a esta pregunta.

### `gupshup-partner-api-contract.md` (ya existente) — qué decía

- Sección 4 (Whitelist): `"Request: Sin body — solo appId en el path"` — **ya documentaba correctamente** que no hay ningún otro parámetro, aunque en su momento no se investigó *por qué* alcanza con eso.
- Sección 6 (Verify): mismo patrón, `"Sin body — solo appId en el path"`. Su catálogo de errores incluye `400 "WABA is not migrated to embed yet, ownership type: ON_BEHALF_OF"` — esta frase (`ON_BEHALF_OF` = OBO) ya era una pista de que estos 2 endpoints viven dentro de un flujo de *migración* OBO→Embed, no se le había dado peso en su momento.
- Ambos marcados `"Last verified: 2026-08-28 — vía Ask AI (no probado en vivo)"` — es decir, ya declarados como no confirmados con un request real, coherente con que esta investigación los vuelva a revisar.

---

## 1. Confirmación estructural: en la documentación de Gupshup, estos 2 endpoints viven bajo "OBO to Embed flow"

Navegando la barra lateral de `partner-docs.gupshup.io` (hecho, no inferido — capturado directo), la sección **"OBO to Embed flow"** contiene únicamente:
- Whitelist the WABA ID (`POST .../obotoembed/whitelist`)
- Verify and attach the Credit Line (`GET .../obotoembed/verify`)

Estos 2 son los ÚNICOS endpoints en toda esa categoría. Es una sección **separada** de "Partner Portal Onboarding API's", que contiene: Create App, Update application, Get app details, Filter/list apps, Set Contact details, Resend verification link, **Generate Embed Signed Link**, Mark APP for migration.

**Fuente**: navegación propia de `partner-docs.gupshup.io` (capturada en vivo). **Confirmado por observación directa**, no por inferencia de IA — esta parte no depende de qué tan bien razonó el Ask AI, es la estructura real del sitio.

---

## 2. Pregunta original: ¿`obotoembed/whitelist` necesita el access token de Meta?

**Respuesta: NO.** Confirmado por dos vías independientes:

### 2.1 — WebFetch directo sobre la página de referencia

Se pidió explícitamente el spec completo (OpenAPI + tabla en prosa + ejemplo cURL) buscando cualquier campo llamado `accessToken`, `access_token`, `metaAccessToken`, `code`, `wabaId`, `waba_id`, `phoneNumberId`, `phone_number_id`. Resultado: **ninguno de esos campos existe**. Los únicos parámetros son el header de auth (`token`/`Authorization`, ver la ambigüedad ya documentada en `gupshup-partner-api-contract.md` hallazgo #1) y `appId` en el path.

**Fuente**: https://partner-docs.gupshup.io/reference/post_partner-app-appid-obotoembed-whitelist
**Confirmado por documentación** — WebFetch, no probado en vivo.

### 2.2 — Ask AI de Gupshup (interacción real, capturada)

Se abrió el widget "Ask AI" directo en la página de referencia del endpoint (**sin necesitar login** — el botón "Open Ask AI Assistant" está disponible sin autenticarse) y se preguntó textualmente:

> *"Does the POST /partner/app/{appId}/obotoembed/whitelist endpoint require a Meta/Facebook access token, or a wabaId/phoneNumberId, in its request body or query params? Or does it only need the appId in the path? How does Gupshup know which WABA to whitelist for a given appId if the request body is empty?"*

Respuesta completa del asistente (transcripta, no resumida):

> *"[...] does not show any request body or query parameters for `wabaId`, `phoneNumberId`, or a Meta/Facebook access token. From the docs, it requires only: `appId` in the path, `Authorization: {PARTNER_APP_TOKEN}` header [...] So based on the documented contract, it appears to whitelist the WABA already associated internally with that Gupshup appId. Why this likely works: The endpoint is app-scoped. Other related APIs indicate Gupshup stores WABA linkage against the app. For example, the WABA info API fetches WABA details using just `appId` + app token and can return errors like: 'Waba id not found for the given App', 'WABA id is invalid or given phone is not associated with waba'. That suggests Gupshup resolves the WABA from its backend mapping for that app, rather than requiring you to pass WABA identifiers in this request. So the practical answer is: No documented body/query params for Meta token, wabaId, or phoneNumberId. Yes, only `appId` + partner app token are required. Gupshup likely uses the WABA already linked to that app record internally. If no WABA is mapped to the app, you'd likely get an error during processing."*

**Fuente**: Ask AI de `partner-docs.gupshup.io`, interacción real del 28 ago 2026 (capturada por navegador). **Nivel de confianza**: alto para el "qué" (no hay esos parámetros — esto lo corrobora también el WebFetch directo del OpenAPI spec en §2.1), moderado para el "por qué" (la explicación de Gupshup del mapeo interno es un razonamiento del asistente basado en los docs, no una cita textual de un párrafo específico que lo diga así de explícito).

**Conclusión sobre la pregunta original**: el mapeo `appId ↔ WABA` ya existe del lado de Gupshup ANTES de llamar a `whitelist`/`verify` — ninguno de los dos endpoints necesita que se le pase el token de Meta, ni `wabaId`, ni `phoneNumberId`. **Esto significa que `ChannelOnboardingSession.meta.accessTokenCipher` (el token que PR-04 cifra y guarda) no lo necesita Gupshup para estos 2 endpoints puntuales.** Su único uso confirmado hasta ahora sigue siendo el de PR-04 mismo: resolver el `phoneNumber` real vía la Graph API de Meta.

---

## 3. HALLAZGO MÁS IMPORTANTE: ¿son `obotoembed/whitelist`/`verify` siquiera los endpoints correctos para un tenant nuevo?

Al confirmar el "cómo" de arriba, surgió una pregunta más fundamental — y la respuesta que se encontró **contradice una conclusión de la investigación anterior (PR-02, ya implementada en el repo)**.

### 3.1 — Lo que dice el Ask AI, preguntado directo

Pregunta hecha al mismo Ask AI:

> *"These 2 endpoints are listed under 'OBO to Embed flow' in the sidebar. Are they ONLY for migrating an existing OBO-onboarded WABA to Embed, or can they also be used for a brand-new tenant doing WhatsApp Embedded Signup for the very first time with no pre-existing WABA on Gupshup?"*

Respuesta completa (transcripta):

> *"Based on the provided docs: How the appId → WABA mapping is created: The mapping is established during the onboarding/go-live flow for that app. The onboarding APIs are app-centric: you create an app first, then use embed/onboarding steps to link the customer's WABA to that app. The whitelist endpoint appears to act on the WABA already linked to that app in Gupshup's backend. Are these only for OBO → Embed migration? The page itself is under 'OBO to Embed flow', so these endpoints are specifically documented for that transition flow. The docs do not explicitly say they support a brand-new tenant with no existing WABA. For brand-new onboarding, the general docs point to: Create App, Set Callback, Generate Embed Signed Link. That suggests first-time Embedded Signup should use the normal onboarding/embed flow, not necessarily the OBO→Embed whitelist endpoint. Joint Solution ID / Meta setup: The docs do say onboarding APIs require: a Gupshup Partner Portal account with an approved Solution ID. They also describe registering a joint Solution ID with Gupshup. Meta App config_id: I cannot answer that question."*

### 3.2 — Corroboración independiente (no solo la IA): `Generate Embed Signed Link`

Se releyó completo el contrato de este endpoint, que **ya existía documentado desde la investigación de PR-02** pero había sido descartado ahí como "un flujo más viejo, sin relación con Embedded Signup moderno":

| Campo | Valor |
|---|---|
| **Path** | `GET /partner/app/{appId}/onboarding/embed/link` |
| **Categoría en el sitio** | "Partner Portal Onboarding API's" (la sección **general**, NO "OBO to Embed flow") |
| **Auth** | Header `token` (sin la ambigüedad Authorization/token que sí tienen whitelist/verify — acá la doc es consistente) |
| **Query params** | `user` (requerido), `lang` (requerido), `regenerate` (boolean, opcional) |
| **Response (200)** | `{ "status": "success", "link": "<embed_link>" }` — válido 5 días |
| **Errores** | `400` query params vacíos / "Max Links Already sent" / link expirado · `401` "Authentication Failed" (appId o token incorrecto) · `429` · `500` (varios) |

**Fuente**: https://partner-docs.gupshup.io/reference/get_partner-app-appid-onboarding-embed-link — releído completo esta vez (WebFetch + navegación directa), no solo por resumen de WebSearch como la primera vez.

**Este es exactamente el endpoint que la investigación de PR-02 descartó explícitamente**, con esta nota en `gupshup-partner-api-contract.md`: *"NO confundir con GET /partner/app/{appId}/onboarding/embed/link, un endpoint DISTINTO y más viejo de Gupshup para un flujo de onboarding sin Embedded Signup — no es el que necesita CREA OS acá."* Esa conclusión se basó en la interpretación de que "OBO" = *on-behalf-of* = "el modelo de Tech Provider de Meta" = lo moderno. **Esta nueva investigación encontró evidencia real (categorización propia del sitio de Gupshup + razonamiento del Ask AI, ambos independientes entre sí) de que podría ser al revés**: "OBO to Embed" es específicamente el flujo de *migración* de una WABA que ya estaba onboardeada bajo el modelo viejo (OBO/"on-behalf-of") hacia el modelo Embed — no el flujo para un tenant que nunca tuvo nada en Gupshup.

### 3.3 — Por qué esto no se puede resolver solo con más lectura de documentación

Se intentó profundizar más (ver §4) pero las fuentes públicas no alcanzan para una confirmación 100% — el propio Ask AI lo dice: *"The docs do not explicitly say they support a brand-new tenant with no existing WABA."* Es una interpretación razonada, no una cita textual que zanje la duda. **Esto es exactamente el tipo de contradicción entre fuentes que no debe resolverse por asunción** — queda como el gap #1, ver más abajo.

---

## 4. Prerrequisito adicional encontrado, independiente de lo anterior: "Solution ID" conjunto

Investigando el flujo general de onboarding (WebSearch + WebFetch, más el Ask AI mencionándolo también sin pedírselo directamente), apareció un requisito que **no estaba documentado en ningún blueprint anterior**:

- Existe un **"Solution ID"**, emitido por Meta, que representa la relación *conjunta* entre CREA OS (el ISV) y Gupshup (el Solution Partner/Tech Provider) — se registra en el Meta Developer Portal y **también** hay que registrarlo del lado de Gupshup (Partner Portal → Settings → enviar el Solution ID + nombre → soporte de Gupshup lo verifica contra Meta y aprueba el mapeo).
- Fuente concreta: *"ISVs working with Solution Partners complete a registration process on Meta Developer Portal and make a joint solution ID with the Solution Partner, which is passed to Meta during phone number onboarding."* (https://partner-docs.gupshup.io/docs/get-solution-id-from-meta, vía WebFetch).
- Otra fuente (WebSearch, contenido de `support.gupshup.io`, no se pudo abrir el artículo completo — ver §5): *"the solution ID will be mapped to the app when you register a PN [phone number] on Meta"* y *"reach out to your CSM and share the partner ID with an active approved solution ID and list of WABAs/Phone numbers you want to attach"* — confirma que el mapeo Solution ID↔WABA es, al menos en algunos casos, un **proceso manual mediado por el CSM (Customer Success Manager) de Gupshup**, no una llamada de API.
- El propio Ask AI, sin que se le preguntara directamente sobre esto la primera vez, lo mencionó de forma espontánea: *"onboarding APIs require: a Gupshup Partner Portal account with an approved Solution ID."*

**Esto es plausiblemente EL mecanismo que explica el hallazgo de §2**: si el Solution ID conjunto ya está registrado y aprobado, Meta puede informarle a Gupshup automáticamente (servidor a servidor, fuera de cualquier llamada que haga el backend de CREA OS) qué WABA quedó asociada a qué `appId` de Gupshup en el momento en que se completa el Embedded Signup — explicando por qué `whitelist`/`verify` no necesitan que se les pase nada de eso explícitamente.

**No se pudo confirmar si CREA OS ya tiene este Solution ID conjunto registrado y aprobado.** La auditoría original de esta fase (anterior a esta investigación) había encontrado un "Solution ID" (`1608486337515105`) y "Wallet ID" (`334449`) mencionados en un contexto previo, sin confirmar si ese Solution ID es específicamente el *conjunto* (CREA OS + Gupshup) que este mecanismo requiere, o un identificador distinto. **Esto no se puede resolver desde este entorno** — no hay acceso al Partner Portal de Gupshup ni al Meta Developer Portal para verificar el estado real de ese registro.

---

## 5. Fuentes intentadas y bloqueadas

Se intentó explícitamente acceder a 2 artículos de `support.gupshup.io` (su centro de ayuda, Zendesk) directamente relevantes:

- *"How to convert WhatsApp Phone Number onboarding method from OBO to Embedded Signup?"*
- *"Tech Provider Setup for Non-TPP (non tech provider) partners on Gupshup"*
- *"How to attach solution ID to a WABA?"*

**Los 3 devolvieron HTTP 403 Forbidden** al intentar acceder vía WebFetch, tanto directo como a través de un proxy de traducción de Google (que sí funcionó para otro dominio de Gupshup, `docs-gupshup-io.translate.goog`, descartando que sea un problema general del método). Esto sugiere que `support.gupshup.io` bloquea específicamente accesos no-navegador/no-autenticados. No se intentó con el navegador interactivo por no ser el foco de esta investigación (el Ask AI de `partner-docs.gupshup.io` sí se probó por navegador y funcionó, ver §2-3) — **si esta pregunta se vuelve crítica para PR-05, vale la pena reintentar estos 3 artículos puntuales con navegador real**, quedó sin agotar esa vía.

Solo se pudo obtener información de estos artículos vía **snippets de WebSearch** (fragmentos cortos, no el artículo completo) — citados en §4 con esa salvedad explícita.

---

## 6. Resumen para decidir el siguiente paso

### Confirmado
1. `obotoembed/whitelist` y `obotoembed/verify` **no necesitan el access token de Meta, ni wabaId, ni phoneNumberId** — solo `appId` + token de partner. Confirmado por WebFetch directo del spec + Ask AI de Gupshup, coincidentes.
2. Existe un prerrequisito de **"Solution ID conjunto"** (CREA OS + Gupshup, registrado en Meta Developer Portal + aprobado en el Partner Portal de Gupshup) que no estaba documentado en ningún blueprint anterior — y que probablemente es el mecanismo real detrás del punto 1.

### ~~Gap sin resolver~~ — RESUELTO, ver §9
3. ~~No está confirmado si `obotoembed/whitelist`/`verify`...~~ **Resuelto (§9): son para migración, no para altas nuevas. El endpoint correcto es `Generate Embed Signed Link`.**
4. ~~No está confirmado si CREA OS ya tiene un Solution ID conjunto aprobado...~~ **Resuelto (§9): sí, `1608486337515105` ("MyrelCompany Gupshup OD"), estado APPROVED, verificado directo en el Partner Portal.**

### ¿Amerita contactar a Dali?

**Sí, y con una pregunta puntual y cerrada** (no una pregunta abierta de investigación — eso ya se agotó por los canales públicos disponibles): dado que el punto 3 es una contradicción real entre lo que el código actual (PR-02) ya implementa y lo que sugiere la categorización propia de Gupshup + su Ask AI, y dado que esto no se puede zanjar sin acceso a su Partner Portal o a alguien de Gupshup con conocimiento directo del producto, la pregunta concreta a llevarle a Dali (o a quien tenga esa relación con Gupshup) sería:

> *"Para un tenant que nunca tuvo WABA en Gupshup, onboardeado 100% vía Meta Embedded Signup desde cero: ¿el flujo correcto es `POST .../obotoembed/whitelist` + `GET .../obotoembed/verify`, o es `GET .../onboarding/embed/link` (Generate Embed Signed Link)? Y, en paralelo: ¿CREA OS ya tiene un Solution ID conjunto con Gupshup aprobado en Meta, y cuál es?"*

Esto bloquea el diseño en firme de PR-05 — vale la pena resolverlo antes de escribir el código de registro real, para no construir sobre el endpoint equivocado.

---

## 7. Investigación adicional (28 ago 2026, sesión 2) — ¿"Generate Embed Signed Link" ya está cubierto por PR-02?

Segunda pasada, pedida antes de escribirle a Dali: confirmar si el wrapper ya implementado cubre de alguna forma el endpoint alternativo (`Generate Embed Signed Link`), y reforzar la evidencia de §3 con una pregunta más directa al Ask AI. **Solo lectura — ningún archivo de código tocado en esta sesión tampoco.**

### 7.1 — Auditoría del wrapper: confirmado, NO está implementado

Se listaron todos los archivos `.js` bajo `src/modules/channels/providers/gupshup/` y se releyó `partner.apps.js` completo. El wrapper expone exactamente 5 funciones: `createApp`, `setContactDetails`, `generateEmbedSignupLink`, `linkAppWithPartner`, `verifyAndAttachCreditLine`. Ninguna otra función existe en ningún otro archivo del módulo (`gupshup.http.client.js`/`partner.auth.js`/`partner.errors.js` no hacen ninguna llamada de negocio propia).

**Hallazgo puntual, digno de mención aparte**: la función ya existente `generateEmbedSignupLink(appId, token)` — **a pesar de su nombre** — implementa `POST /partner/app/{appId}/obotoembed/whitelist`, **no** `GET /partner/app/{appId}/onboarding/embed/link` (que es el endpoint que Gupshup llama literalmente "Generate Embed Signed Link" en su propia documentación). Es una colisión de nombres real dentro del propio código del repo: el nombre de la función en `partner.apps.js` coincide con el *display name* del endpoint que, según esta investigación, sería el correcto — pero apunta a un path distinto. Esto es puramente una observación de auditoría (no se tocó el código); vale la pena tenerlo presente para no confundirse a la hora de nombrar la función nueva si PR-05 termina necesitando `onboarding/embed/link` de verdad.

**Conclusión de 7.1**: `GET /partner/app/{appId}/onboarding/embed/link` es **100% territorio nuevo** — cero código escrito para él, en ningún archivo.

### 7.2 — Contrato de "Generate Embed Signed Link", releído completo desde la fuente

Ya estaba documentado en §3.2, pero se releyó la página completa (no solo un resumen) para esta sesión — sin cambios respecto a lo ya registrado:

| Campo | Valor |
|---|---|
| **Path** | `GET /partner/app/{appId}/onboarding/embed/link` |
| **Auth** | Header `token` (JWT de partner) — sin la ambigüedad Authorization/token que sí tienen whitelist/verify |
| **Query params** | `user` (string, requerido — error 400 si vacío), `lang` (string, requerido — error 400 si vacío), `regenerate` (boolean, opcional, default `false`) |
| **Response (200)** | `{ "status": "success", "link": "<embed_link>" }` — válido 5 días |
| **Errores** | `400` query params vacíos / `"Max Links Already sent, please contact support..."` / link expirado · `401` `"Authentication Failed"` (appId o token incorrecto) · `429` · `500` (`"Unable to create link"` / `"Unable to get link"` / `"Max link already sent"` — máx. 40 regeneraciones, máx. 5 links nuevos) |
| **Source documentation** | https://partner-docs.gupshup.io/reference/get_partner-app-appid-onboarding-embed-link |
| **Last verified** | 2026-08-28 — vía WebFetch/navegación directa (releído completo). No probado en vivo. |

### 7.3 — Ask AI, pregunta directa y textual (la que se pidió explícitamente)

Se abrió el Ask AI **desde la propia página de "Generate Embed Signed Link"** (sin login, igual que en §2-3) y se preguntó exactamente:

> *"For a brand-new tenant with no existing WABA, doing Embedded Signup for the first time, which endpoint should be called: Generate Embed Signed Link, or whitelist+verify (the obotoembed endpoints)?"*

Respuesta completa (transcripta, sin resumir ni parafrasear):

> *"For a brand-new tenant with no existing WABA doing Embedded Signup for the first time, use Generate Embed Signed Link.*
>
> *Why:*
> *- Generate Embed Signed Link returns the onboarding/embed link used to start the embedded signup flow.*
> *- The obotoembed whitelist/verify endpoints are for the OBO to Embed flow, typically when handling an existing WABA / migration / whitelist-related setup, not the first-time fresh embedded signup case.*
>
> *Endpoint to use: [ejemplo cURL de GET .../onboarding/embed/link con regenerate/user/lang y header token]*
>
> *Notes: The signed link is valid for 5 days. Required inputs: token header = valid Partner JWT token; appId = valid app ID; user and lang query params must not be empty.*
>
> *Success response: { "status": "success", "link": "<embed_link>" }*
>
> *If you want, I can also show the full first-time Embedded Signup sequence after generating this link."*

**Esta respuesta es notablemente más directa y menos condicional que la de §3.1** — ahí el Ask AI había dicho *"the docs do not explicitly say..."* (una inferencia con reservas); acá, preguntado desde el contexto de la página correcta, respondió sin ese matiz: *"not the first-time fresh embedded signup case"*, en afirmativo. Se obtuvo la misma conclusión desde **dos preguntas distintas, en dos sesiones de chat distintas, formuladas desde dos páginas de contexto distintas** — la consistencia entre ambas sube razonablemente la confianza, aunque sigue siendo la interpretación de una IA sobre su propia documentación, no una cita de un párrafo humano que lo declare así de explícito en un solo lugar.

**Fuente**: Ask AI de `partner-docs.gupshup.io`, interacción real del 28 ago 2026 (segunda sesión de chat, capturada por navegador).

### 7.4 — Qué le faltaría al wrapper si esto se confirma (documentado, NO implementado)

Si Dali confirma que `Generate Embed Signed Link` es el endpoint correcto, esto es exactamente lo que le faltaría a `partner.apps.js` (para referencia de PR-05, no se escribió nada de esto):

- Una función nueva (nombre sugerido para evitar la colisión de 7.1, ej. `getEmbedSignupLink(appId, { user, lang, regenerate }, token)`) que llame `GET /partner/app/{appId}/onboarding/embed/link` con esos 3 query params.
- Ningún cambio a `createApp`/`setContactDetails` — esos 2 pasos previos del onboarding siguen aplicando igual, sean cuales sean los endpoints de whitelist que se usen después.
- Decidir qué pasa con `generateEmbedSignupLink()`/`verifyAndAttachCreditLine()` (los 2 de PR-02): si `whitelist`/`verify` resultan ser exclusivamente para migración OBO→Embed, esas 2 funciones quedarían sin uso en el flujo de onboarding fresco de CREA OS — no se recomienda borrarlas todavía (podrían servir el día que CREA OS necesite migrar un tenant que ya tenía WABA en otro BSP), pero sí re-documentar su JSDoc para dejar de decir *"el real para Meta Embedded Signup"* si se confirma que no lo es.

---

## 8. Pregunta final para Dali (actualizada con la evidencia de §7 — lista para copiar)

> Hola Dali — necesitamos confirmar un detalle técnico antes de seguir construyendo el flujo de alta de números de WhatsApp para clientes nuevos de CREA OS.
>
> Para un tenant que **nunca tuvo una WABA en Gupshup**, haciendo el WhatsApp Embedded Signup de Meta por primera vez (alta 100% desde cero, no una migración desde otro BSP ni desde un número que ya estaba en modo OBO con ustedes):
>
> 1. **¿El flujo correcto es `POST /partner/app/{appId}/obotoembed/whitelist` + `GET /partner/app/{appId}/obotoembed/verify`, o es `GET /partner/app/{appId}/onboarding/embed/link` (Generate Embed Signed Link)?**
>    Lo preguntamos porque en su propia documentación (`partner-docs.gupshup.io`) los dos primeros están agrupados bajo una categoría llamada "OBO to Embed flow", separada de "Partner Portal Onboarding API's" (donde vive Generate Embed Signed Link) — y el asistente de IA de su documentación, consultado directamente, nos confirmó que "OBO to Embed" es para migrar una WABA que ya estaba onboardeada en el modelo OBO, no para un alta 100% nueva.
>
> 2. **¿CREA OS ya tiene un "Solution ID" conjunto (CREA OS + Gupshup) registrado en el Meta Developer Portal y aprobado en el Partner Portal de ustedes?** Si no lo tiene, ¿cuál es el proceso y cuánto puede demorar? Entendemos que este Solution ID es lo que le permite a Meta informarle a Gupshup automáticamente qué WABA quedó asociada a cuál de nuestras apps — sin eso, sospechamos que el onboarding automatizado no puede funcionar de punta a punta sin importar cuál de los dos flujos de arriba sea el correcto.
>
> Cualquier documentación interna, ejemplo de código, o llamada rápida que nos ayude a confirmar esto nos desbloquea para terminar de construir el flujo de alta automática. ¡Gracias!

Esta versión reemplaza a la de §6 como la pregunta a enviar — la de §6 queda como registro histórico de cómo evolucionó la pregunta a lo largo de la investigación.

**Nota (ver §9): esta pregunta ya fue enviada y respondida — se deja intacta como registro de qué exactamente se preguntó, no como una acción pendiente.**

---

## 9. CONFIRMACIÓN FINAL — 3 fuentes independientes, gap cerrado (28 ago 2026)

A diferencia de todo lo anterior en este documento (interpretación de un asistente de IA sobre su propia documentación), esta sección se apoya en **una fuente humana directa** más una **verificación propia de primera mano** — el nivel de confianza más alto que este documento va a tener en ningún otro punto.

### 9.1 — Dali (contacto humano de Gupshup, por WhatsApp Business) — fuente humana directa

Confirmó por escrito:
- El flujo correcto para un alta 100% nueva es la **Opción B: `GET /partner/app/{appId}/onboarding/embed/link`** (Generate Embed Signed Link).
- El Solution ID se revisa en `partner.gupshup.io` → **Ajustes → Soluciones**.

**Naturaleza de esta fuente**: humana, directa, por escrito — no es una inferencia de IA sobre documentación pública. Es la fuente de mayor peso de todo este documento.

### 9.2 — Ask AI de Gupshup, consultado por separado el mismo día

Confirmó lo mismo, citando documentación oficial: para altas nuevas usar `Generate Embed Signed Link`; `obotoembed/whitelist` + `verify` son específicamente para el flujo "OBO to Embed" (migración desde otro BSP, o desde un número que ya estaba en modo OBO) — no para onboarding fresco. También citó el prerrequisito de Solution ID aprobado + wallet de Gupshup, consistente con §4.

**Naturaleza de esta fuente**: la misma que en §2/§3/§7 (interpretación de IA sobre documentación) — pero ahora **coincide con una fuente humana independiente (§9.1)**, lo que la corrobora en vez de dejarla como la única base de la conclusión.

### 9.3 — Verificación propia, directa, en el Partner Portal

Confirmado entrando directo a `partner.gupshup.io` → Ajustes → Soluciones: el Solution ID de CREA OS (**"MyrelCompany Gupshup OD"**, ID `1608486337515105`) figura con **Estado: APPROVED**.

**Naturaleza de esta fuente**: observación directa de primera mano sobre el propio Partner Portal — no es documentación pública ni interpretación de IA, es el estado real de la cuenta de CREA OS.

### 9.4 — Conclusión y qué cambia en el repo

**No hay ningún bloqueante externo restante** para diseñar PR-05 en firme:

- **Endpoint correcto para PR-05**: `GET /partner/app/{appId}/onboarding/embed/link` (Generate Embed Signed Link) — confirmado por 2 fuentes independientes (§9.1 humana + §9.2 IA), consistente con la evidencia estructural ya reunida en §3.2/§7.
- **`obotoembed/whitelist` y `obotoembed/verify` (ya implementados en PR-02, `partner.apps.js#generateEmbedSignupLink()` y `#verifyAndAttachCreditLine()`) quedan documentados como IMPLEMENTADOS PERO RESERVADOS PARA UN FUTURO CASO DE MIGRACIÓN — no se usan ni se deben usar en el flujo principal de PR-05.** Ninguno de los dos se toca ni se borra: siguen ahí, funcionando, para el día que CREA OS necesite migrar un tenant que ya tenía WABA en otro BSP o en modo OBO. **Que quede explícito para quien lea este código en el futuro: que existan y tengan tests en verde no significa que estén integrados al flujo de onboarding activo.**
- **Solution ID conjunto**: ya existe y está `APPROVED` — no es un prerrequisito pendiente para PR-05, es un hecho ya resuelto del lado de la cuenta de CREA OS.
- La pregunta de §8 ya cumplió su función — no hace falta reenviarla ni reformularla.
