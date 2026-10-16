# 38 — «Mi negocio» y moneda: qué se guarda de verdad (DIAGNÓSTICO, SOLO LECTURA)

Fecha: 2026-10-16 · **No se cambió código, no hay push ni despliegue, no se consultó producción.** Código leído: backend `main` (`25ef139`) y frontend `main` (`4aa9863`, lo que sirve Vercel). Etiquetas: **[CONFIRMADO]** (leído en el código/tests) · **[INFERIDO]** · **[DESCONOCIDO]** (datos de producción que no pude mirar).

---

## 1. Respuestas cortas
1. **La moneda SÍ la guarda el backend** (`Business.currency`, colección `businesses`) cuando se pulsa «Guardar cambios». No es solo del frontend. El arreglo `fix(business): nombre y moneda del negocio ahora persisten` ya está en `main` del frontend.
2. **Pero hay dos defectos reales alrededor de la moneda:**
   - **El valor por defecto es `MXN` para TODO negocio nuevo** (valor del esquema desde el primer commit), aunque el país por defecto ya es `PE`. Nadie lo elige: ni el registro ni el onboarding preguntan la moneda.
   - **La moneda «global» de la app (símbolo en Dashboard, Leads, Pipeline, Estadísticas) nunca lee `Business.currency`**: lee `user.currency`, un campo que `/users/me` no devuelve ⇒ **siempre `USD` («$»)** salvo mientras dura la sesión en la que se cambió el selector.
3. **Hay campos de «Mi negocio» que muestran «Cambios guardados» y NO se guardan en ningún sitio:** los 3 scripts de mensajes, el objetivo mensual y el tipo de negocio (y 5 más sin control visible). Se pierden al recargar.
4. **`MXN` por defecto es universal** (cualquier negocio nuevo), no específico de un tenant.

---

## 2. La moneda, de punta a punta

| # | Eslabón | Dónde | Qué hace |
|---|---|---|---|
| 1 | Alta de la cuenta | `auth.service.js:190` y `:201` → `Business.create({ name, createdBy })` | Crea el negocio **solo con nombre**; no pasa país ni moneda ⇒ aplican los *defaults* del esquema |
| 2 | Valor por defecto | `business.model.js:180-185` → `currency: { type: String, trim, uppercase, default: 'MXN' }` | **`MXN`** |
| 3 | Lectura al abrir «Mi negocio» | `business.tsx:448` (`merged.currency = biz.currency`), `business.ts:99` (`toStr(b.currency)`), `GET /api/v1/businesses/current` | El selector muestra lo que haya en `Business.currency` (en un negocio nuevo, `MXN`) |
| 4 | Pantalla | `business.tsx:737-739` → `<CurrencySelect value={p.currency ?? "USD"} onChange={update("currency")}>`; lista fija `PEN, USD, MXN, ARS, COP` (`currency.tsx:6-12`) | Cambiar el selector solo cambia el estado local `p` (y llama a `setCurrency`, ver §2.2) |
| 5 | Guardar | `business.tsx:540-570` `saveAll()` → `updateCurrentBusiness({ …, currency: p.currency ?? "", … })` → `business.ts:210` `body.currency = input.currency` → **`PUT /api/v1/businesses/current`** | Envía **todos** los campos de identidad de una vez |
| 6 | Validación en la ruta | `business.routes.js:89` → `body('currency').optional().trim().isLength({ min: 3, max: 3 })` | Solo comprueba **3 caracteres**: acepta `ABC`; **no** tiene `checkFalsy`, así que `""` falla (422) |
| 7 | Lista blanca del servicio | `business.service.js:139` `camposPermitidos` incluye `'currency'` | Pasa a la actualización |
| 8 | Persistencia | `business.service.js` → `Business.findByIdAndUpdate(id, actualizacion, { new:true, runValidators:true })` | **Escribe en Mongo**; responde el negocio actualizado (`data.negocio`) |
| 9 | Eco en el cliente | `business.ts:setNegocioCache(normalize(...))` | El caché de 10 s del cliente queda con el valor guardado |
Evidencia de tests: `business.routes.updateValidation.e2e.test.js` (envía `currency: 'MXN'` y comprueba que llega al servicio) y `business.service.actualizarNegocio.test.js`: 10/10 verdes.

### 2.1 Dónde se usa la moneda guardada
- **Prompt de la IA** (`ai.service.js:514`): «Ticket promedio: {averageTicket} {business.currency}».
- **Herramientas de la IA** (`product.service.js:24-28, 200, 288`): `resolverMoneda(producto, business) = producto.currency || business.currency` ⇒ el precio que la IA da al cliente lleva la moneda del negocio.
- **Formulario de productos** (`ProductCatalogSection.tsx:88`): `defaultCurrency = business?.currency ?? "USD"`: la moneda que sale preseleccionada al crear un producto.
- **Etiqueta «Objetivo mensual (…)»** (`business.tsx:925`).

### 2.2 El defecto del símbolo global [CONFIRMADO]
`CurrencyProvider` (`currency.tsx:44-56`) toma la moneda de `user.currency`, y `user` viene de `GET /api/v1/users/me`. Ese endpoint (`user.service.js obtenerMiPerfil`) devuelve el `User` con `business` poblado **solo** con `name slug logo onboardingCompleted`, y el modelo `User` no tiene `currency` ⇒ `user.currency` es siempre `null` ⇒ **la moneda global es siempre `USD`**. Se actualiza solo en memoria cuando alguien mueve el selector (`business.tsx:498-499`) y **se pierde al recargar o iniciar sesión de nuevo**. Consumidores del `format()` global: Dashboard, Leads, Pipeline, Estadísticas, Onboarding y `wow.tsx`.
Impacto visible: solo cambia el símbolo del **sol** (`S/`); MXN, USD, ARS y COP comparten «$». Un negocio peruano con `PEN` guardado ve «$» en esas pantallas tras recargar.

### 2.3 Dos bordes adicionales
- **PUT que se rechaza entero:** si `getCurrentBusiness()` falla (devuelve `null` ante cualquier error), `p.currency` queda `null` y `saveAll()` manda `currency: ""` ⇒ el validador (sin `checkFalsy`) responde **422 «Moneda inválida»** y **no se guarda nada del bloque de identidad** (nombre, agente, instrucciones, enlaces…). El código ya tuvo el mismo defecto con `website` y `whatsappNumber` (arreglados con `checkFalsy`); `currency`, `name` y `agentName` siguen igual.
- **Sin lista blanca ISO:** el backend acepta cualquier cadena de 3 letras; el frontend solo ofrece 5 monedas (no hay CLP, BOB, etc., aunque el *prompt* de guardia de precios sí las conoce).

---

## 3. El resto de los campos de «Mi negocio»

`saveAll()` hace **dos** llamadas: (A) `PUT /businesses/current` (persiste) y (B) `PUT /users/me` (`updateMe`). **(B) no persiste nada de esto**: `user.controller.js:27` solo lee `{ name, phone, avatar }` **del usuario**; el resto se descarta en silencio. Por eso el aviso «Cambios guardados» (que depende solo de que (A) no falle) es engañoso para los campos sin hogar.

### 3.1 Se guardan (llamada A y/o endpoints dedicados) [CONFIRMADO]
| Campo en pantalla | Campo del backend (`Business`) | Validación | Notas |
|---|---|---|---|
| Nombre del negocio | `name` (`:61`) | ruta 2-100; esquema requerido 2-100 | `""` ⇒ 422 de todo el PUT |
| Nombre del agente | `agentName` (`:75`) | máx 50 | `""` limpia; la IA usa «Alex» |
| Qué vendes | `productDescription` (`:232`) | máx 500 | |
| Ticket promedio | `averageTicket` (`:239`) | número ≥ 0 | si está vacío se envía `0` |
| Moneda | `currency` (`:180`) | 3 caracteres (§2) | |
| Cliente objetivo | `targetCustomer` (`:245`) | máx 300 | |
| WhatsApp del negocio | `whatsappNumber` (`:225`) | saneado en ruta; validador E.164 en el esquema | `""` permitido |
| Instrucciones para la IA | `aiInstructions` (`:258`) | máx 1500 | Las lee `buildSystemPrompt` |
| Personalidad | `aiPersonality` (`:271`) | `cercano`/`formal`/`agresivo` | |
| Sitio web | `website` (`:197`) | URL (con `checkFalsy`) | |
| Facebook / Instagram / TikTok | `facebookUrl` `instagramUrl` `tiktokUrl` (`:206-218`) | `esUrlValida` en el esquema (`""` válido) | |
| Ventas automáticas con IA | `aiSalesEnabled` | booleano | Llamada propia (`updateCurrentBusiness({ aiSalesEnabled })`) |
| **Logo** | `logo`, `logoAsset` | multipart, imagen | `POST /businesses/current/logo` (dedicado, sube a Cloudinary) |
| **Fotos (1-2)** | `photos`, `photoAssets` | multipart | `POST …/photos` |
| **PDF informativo** | `pdfUrl`, `pdfAsset`, texto extraído y resumen | PDF ≤ 10 MB | `POST …/pdf` |
| **Video / Brochure** | `presentationVideo*`, `brochure*` | | endpoints dedicados |

### 3.2 NO se guardan en ningún sitio [CONFIRMADO: `grep` en el backend no encuentra ninguno de estos nombres]
| Campo en pantalla (sección) | Visible | Qué ocurre al guardar |
|---|---|---|
| Script de bienvenida, Seguimiento automático, Cierre (**«Mensajes y scripts»**) | Sí | Van a `PUT /users/me` ⇒ descartados. **Tampoco los lee la IA** |
| Objetivo mensual (**«Configuración de ventas»**) | Sí | Descartado |
| Tipo de negocio (**«Configuración de ventas»**) | Sí | Descartado |
| `ai_mode` («Nivel») | No (oculto a propósito) | Descartado |
| `source_facebook_ads`, `source_tiktok_ads`, `source_landing` | No hay control | Descartados |
Tras recargar, esos controles aparecen vacíos/por defecto porque `getMe()` no los devuelve.

---

## 4. De dónde sale el `MXN` por defecto, y si es universal

- **Origen:** `business.model.js:180-185`, `default: 'MXN'`, presente desde el **primer commit del modelo** (`2b4a11e`, 28/jun/2026) [CONFIRMADO con `git log -S`]. Mismo origen que `country`, que venía como `'MX'` y se corrigió a `'PE'` el 19/sep/2026 con una migración puntual (`scripts/migrate-business-country-pe.js`) porque «ningún formulario escribe este campo»; **la moneda no recibió esa corrección**.
- **Es universal:** el alta (`auth.service.js:190/201`) no pasa ni país ni moneda y el onboarding no pregunta moneda (`onboarding.tsx` solo usa `useCurrency()` para mostrar). Todo negocio nuevo nace con `country: 'PE'` y `currency: 'MXN'` (inconsistente) hasta que alguien abre «Mi negocio» y la cambia. **No hay ninguna rama por tenant.**
- Otras monedas por defecto del sistema, que no coinciden entre sí: `Lead.currency` = `'USD'` (`lead.model.js:103`), `Product.currency` = `null` (cae al negocio, a propósito, `product.model.js:43-49`), frontend `USD` (`currency.tsx`, `ProductCatalogSection.tsx:88`, `CurrencySelect`), planes de suscripción `USD`.
- **Efecto sobre clientes finales:** para un negocio que nunca tocó la moneda, la IA presenta los precios con «MXN» (§2.1).

---

## 5. Arreglo universal propuesto (NO aplicado) y sus pruebas

Principio: una sola fuente de verdad (`Business.currency`), un valor por defecto coherente con el país, y ningún caso especial por tenant.

**Backend**
1. **Moneda por defecto derivada del país** (una función pura `monedaPorPais(country)` y `default` del esquema como función: `function () { return monedaPorPais(this.country) }`; `country` se define antes que `currency` en el esquema). Tabla pequeña (`PE→PEN, MX→MXN, CO→COP, AR→ARS, US→USD …`, desconocido ⇒ `USD`). Así el alta ya produce `PEN` con `country: 'PE'`, sin tocar el flujo de registro.
2. **Validación**: `optional({ checkFalsy: true })` para `currency` (un `""` no tumba el PUT) y `isIn(<lista ISO 4217 admitida>)` en lugar de «3 caracteres».
3. **Datos existentes**: **no** corregir a ciegas. Primero una consulta de **solo lectura** que cuente `{ currency: 'MXN', country: 'PE' }` (candidatos) y que el dueño decida; un `MXN` podría ser una elección real. Si se aprueba, un script de migración con *dry-run* por defecto, igual que `migrate-business-country-pe.js`.
4. **Campos sin hogar** (decisión de producto, dos caminos): (a) **quitarlos** de la pantalla, o (b) añadirlos al esquema `Business` + `camposPermitidos` + validador (`scripts` ≤ 1000 caracteres, `monthlyGoal` ≥ 0, `businessType` lista) y, si los scripts deben influir en la IA, leerlos en `buildSystemPrompt`.

**Frontend**
5. `CurrencyProvider` debe leer **`getCurrentBusiness().currency`** (la fuente real) en lugar de `user.currency`, y volver a leerla al iniciar sesión.
6. `saveAll()` no debe enviar `currency`/`name` vacíos (omitirlos) y debe avisar de forma distinta cuando una parte no se guarda (o dejar de mostrar «Cambios guardados» para campos sin hogar).
7. El onboarding puede mostrar la moneda inferida del país y permitir cambiarla (opcional).

**Pruebas que lo demuestran**
- Backend: (i) `Business.create({ name, country:'PE' })` ⇒ `currency:'PEN'`; con `country:'MX'` ⇒ `'MXN'`; país desconocido ⇒ `'USD'`; con `currency` explícita se respeta. (ii) Ruta: `PUT {currency:'PEN'}` ⇒ 200 y `GET` devuelve `PEN` (ida y vuelta real con Mongo); `PUT {currency:''}` ⇒ 200 sin tocar la moneda; `PUT {currency:'ABC'}` ⇒ 422. (iii) Prompt de la IA y `get_price` usan la moneda del negocio. (iv) Contrato «ida y vuelta» por campo de `Profile`: o persiste (guardar → recargar → mismo valor) o está en una lista explícita de campos no soportados que rompe el test si se muestra en pantalla (misma idea que el contrato anti-rotura del registro de activos).
- Frontend: (i) `CurrencyProvider` con `getCurrentBusiness` simulado en `PEN` ⇒ `format(1500)` = `S/ 1,500` tras «recargar»; (ii) `saveAll` sin moneda cargada no envía `currency:""`; (iii) un test estático de que no queda un consumidor de `user.currency`.

Tamaño estimado: backend pequeño (1 función, 1 validador, tests); frontend pequeño (1 proveedor, 1 función); migración de datos y decisión de los campos sin hogar, aparte.

---

## 6. Lo que NO pude verificar
1. **Datos reales en Atlas:** cuántos negocios tienen `currency: 'MXN'` y cuántos de ellos la eligieron a propósito (consulta de lectura sugerida: `businesses` con filtro `{ "currency": "MXN" }` y mirar solo `country`/`currency`; no abrir nombres).
2. **Comportamiento en el navegador/teléfono:** no abrí la app; el diagnóstico es por lectura de código y tests (los 10 tests de `businesses` pasan).
3. **El APK/AAB en los teléfonos** empaqueta su propio frontend: no sé qué versión de «Mi negocio» tiene cada dispositivo.
4. Si algún cliente (p. ej. una pantalla de administración) escribe `Business.currency` por otra ruta: `admin.controller.js` (`:221` y `:423`) permite `currency` en actualizaciones de administración; no lo seguí.
5. Qué moneda ve la IA en las conversaciones reales de cada tenant (depende de los datos del punto 1).
6. No probé el PUT contra un servidor real; la afirmación de que `""` da 422 sale del validador (`isLength` sin `checkFalsy`) y del precedente documentado con `website`.
