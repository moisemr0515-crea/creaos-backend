# 39 — Arreglo universal de moneda y honestidad de «Mi negocio» (APLICADO EN LOCAL, SIN DESPLEGAR)

Fecha: 2026-10-16 · **No hay push, no se fusionó nada en `main`, no se desplegó, no se consultó producción y NO se migró ningún dato.**
Ramas nuevas desde `main` de cada repo: backend `fix/moneda-backend` (desde `25ef139`) y frontend `fix/moneda-frontend` (desde `4aa9863`). Parte del diagnóstico de `audit/38`. Etiquetas: **[CONFIRMADO]** (código/tests) · **[DESCONOCIDO]** (producción).

| Repo | Rama | Commit | Verificación |
|---|---|---|---|
| Backend | `fix/moneda-backend` | `22d68bf` (+ este informe y `audit/38`) | **198 suites / 1978 tests verdes** (`--maxWorkers=2`); `git diff --check` limpio |
| Frontend | `fix/moneda-frontend` | `5583cb2` | **37 archivos / 261 tests verdes**; `tsc` sin errores; `vite build` correcto; `git diff --check` limpio |

---

## 1. Backend

**Cambios** (`src/modules/businesses/`):
1. **`currencyByCountry.js` (nuevo)**: función pura `monedaPorPais(país)` — `PE→PEN, MX→MXN, CO→COP, AR→ARS, US/EC/PA/SV→USD`; país vacío o desconocido ⇒ `USD` (moneda de referencia, marcado con comentario `shortcut:` en el código). Solo devuelve monedas que el selector de «Mi negocio» sabe mostrar. Sin ninguna rama por tenant.
2. **`business.model.js`**: `currency` pasa de `default: 'MXN'` a un *default* que llama a `monedaPorPais(this.country)` (`country` está definido antes en el esquema, y su valor por defecto es `PE`). Efecto: **todo negocio nuevo nace en `PEN`** salvo que se cree con otro país o moneda explícitos. **Solo aplica al crear**: los documentos ya guardados no cambian.
3. **`business.routes.js`**: `name` y `currency` con `optional({ checkFalsy: true })`; `currency` pasa de «3 caracteres cualesquiera» a **3 letras** (`/^[A-Za-z]{3}$/`) con mensaje claro «Moneda inválida (3 letras, ISO 4217)».
4. **`business.service.js`**: `name` y `currency` **vacíos o con solo espacios se ignoran** (conservan su valor) en lugar de borrarlos o rechazar el PUT. El resto de los campos sigue pudiendo limpiarse con `""` (p. ej. `agentName`).

**Resultado:** `PUT /businesses/current` con `{ name: "", currency: "", agentName: "Marina", averageTicket: 150, aiInstructions: "…" }` ⇒ 200, y se guardan agente, ticket e instrucciones; ya no se pierde el bloque de identidad. Una moneda mal formada (`AB`, `ABCD`, `12A`) da un 422 claro **por campo**; un nombre real demasiado corto (`A`) sigue dando 422 «Nombre inválido» (no se ignora).

**Pruebas** (41 tests en 3 archivos, más la suite completa):
- `currencyByCountry.test.js`: función pura (países, minúsculas/espacios, valores no reconocidos, solo monedas del selector) y default del modelo **sin base de datos** (nombre solo ⇒ `PEN`; `MX`⇒`MXN`; `CO`⇒`COP`; país fuera de tabla ⇒ `USD`; moneda explícita respetada y en mayúsculas).
- `business.service.moneda.test.js` (Mongo real): nace en `PEN`; `currency:""`/`name:""` conservan valor y el resto SÍ se guarda; solo espacios también; moneda real ida y vuelta con la base (`mxn`→`MXN`→`COP`); `agentName:""` sí limpia; **un negocio viejo guardado con `MXN` conserva `MXN` (no se migra nada)**.
- `business.routes.updateValidation.e2e.test.js` (ruta real con supertest): vacíos y espacios no tumban el PUT; `PEN/pen/MXN` válidas; `AB/ABCD/12A/P N` ⇒ 422 con «Moneda inválida»; `name:"A"` ⇒ 422.

## 2. Frontend

**Cambios:**
1. **`currency-core.ts` (nuevo, lógica pura)** y **`currency.tsx`**: `CurrencyProvider` ahora lee **`getCurrentBusiness().currency`** al iniciar sesión (y se reinicia al cambiar de usuario) en lugar de `user.currency`. **Sin moneda no se inventa USD**: `currency = null`, símbolo `""` y `format(1500)` ⇒ `1,500`. `PEN` ⇒ `S/ 1,500`; las demás del selector ⇒ `$1,500`; un código válido fuera del selector (p. ej. `CLP`) ⇒ `CLP 1,500`. Fuera del proveedor tampoco asume ninguna moneda. `setCurrency` sigue actualizando en vivo al cambiar el selector.
2. **`ProductCatalogSection.tsx`**: la moneda por defecto del formulario es la del negocio (o ninguna: el producto cae a la del negocio en el servidor); en la lista, el producto y la variante sin moneda propia muestran la del negocio (antes «$» o «USD» inventado).
3. **`business.tsx` (Mi negocio):**
   - El selector de moneda ya no muestra «USD» cuando no hay moneda.
   - **Deshabilitados con «Próximamente» y sin enviar nada:** los 3 scripts (bienvenida, seguimiento, cierre), el objetivo mensual y el tipo de negocio. Aviso en la sección de scripts («todavía no se guardan ni los usa tu IA»).
   - **Se eliminó la llamada a `PUT /users/me`** (`updateMe`): no persistía nada de esto. El mensaje «Cambios guardados» solo aparece si el PUT real de identidad (`/businesses/current`) salió bien. El estado «Guardando…» ahora lo gestiona `saveAll` directamente.
   - **«Nivel» y las fuentes de leads:** «Nivel» ya estaba oculto (solo en un comentario) y las fuentes no tenían ningún control; se quitaron del tipo `Profile` las tres `source_*` que ya no se usan.
   - No se creó ningún endpoint nuevo.

**Pruebas:**
- `currency-core.test.ts`: normalización de códigos; `monedaDelNegocio` (`PEN`, `cop`→`COP`, `null`/`{}`/`undefined` ⇒ `null`, nunca USD); símbolos; `formatCurrency` en los 4 casos; **«tras recargar, PEN ⇒ `S/ 1,500`»** y «negocio ilegible o sin moneda ⇒ `1,500`» vía `cargarMonedaDelNegocio` (lo que ejecuta el proveedor); guardias de código: `currency.tsx` usa `getCurrentBusiness` y no contiene `user.currency` ni `"USD"`; ni el catálogo ni «Mi negocio» tienen `?? "USD"`.
- `business.honesty.test.ts` (estático sobre `business.tsx`, sin comentarios): sin `updateMe` ni `await save(`; el éxito depende de `identidadOk`; ningún `update(...)` sobre los 5 campos; los 5 controles llevan `<ProximamenteBadge />` y `disabled`; «Nivel» sigue sin renderizarse y no existen las fuentes de leads.
- Limitación: los tests del repo corren en Node sin DOM, así que **no hay un test de renderizado** del proveedor ni de la pantalla (ver §4).

## 3. Efecto sobre los datos y compatibilidad
- **No se migra nada.** Los negocios existentes que hoy tienen `MXN` (valor por defecto antiguo) siguen en `MXN` hasta que alguien la cambie en «Mi negocio»; para ellos la IA seguirá citando precios en MXN. Decidir qué hacer con ellos requiere la consulta de **solo lectura** propuesta en `audit/38` (negocios con `currency: "MXN"` y `country: "PE"`) y tu aprobación.
- **Backend nuevo + frontend actual ✔:** el frontend viejo manda `currency:""` cuando no tiene moneda y ahora el servidor lo ignora (antes daba 422). **Frontend nuevo + backend actual ✔:** solo lee `GET /businesses/current`, que ya existe. Orden recomendado si se despliegan: backend primero.
- **Una petición más por sesión:** el proveedor llama a `GET /businesses/current` al iniciar sesión (el caché de 10 s del cliente la comparte con «Mi negocio»). Un rol sin el permiso `businesses:read` no obtiene moneda y verá los importes sin símbolo.
- **Conflictos al fusionar con las ramas de integración (simulado con `git merge-tree`, sin escribir nada):**
  - `fix/moneda-frontend` + `integration/fase3-frontend`: **conflicto en `src/routes/business.tsx`** (ambas cambian líneas de esa pantalla: el tuteo y esta corrección). Se resuelve a mano al fusionar la segunda; el resto se fusiona solo.
  - `fix/moneda-backend` + `integration/fase3-backend`: el único conflicto es `fase3.diagnostico.characterization.test.js` (*add/add*), que **ya existía antes de este cambio** (esa rama integra todo lo de Fase 3 y `main` ya tiene la parte reducida); no lo causa esta corrección.

## 4. Lo que NO pude verificar
1. **Comportamiento en pantalla:** no abrí el navegador ni un teléfono. No hay pruebas de renderizado (el repo no tiene DOM en sus tests): el proveedor y la pantalla se verificaron con lógica pura, pruebas estáticas, `tsc` y `vite build`. Conviene una pasada visual: Dashboard/Leads/Pipeline con `PEN` (símbolo `S/` tras recargar), «Mi negocio» (los 5 controles deshabilitados, selector de moneda, guardar) y el formulario de producto.
2. **Datos reales en Atlas:** cuántos negocios tienen `MXN` y cuántos la eligieron a propósito (§3); no se tocó ninguno.
3. **El APK/AAB:** empaqueta su propio frontend; los teléfonos no recibirán esto hasta un AAB nuevo.
4. **Roles sin `businesses:read`:** el efecto (importes sin símbolo) se deduce del código; no lo probé.
5. **La tabla país→moneda** es pequeña a propósito (5 monedas del selector); un país fuera de ella obtiene `USD` por defecto. Si hay negocios en otros países (CL, BO, EC con moneda propia…), hay que ampliar la tabla **y** el selector a la vez.
6. No ejecuté nada contra un servidor real: el PUT se probó con la ruta real y Mongo local, no contra producción.
7. Quedó sin seguimiento `.vercel/` en el frontend y `.email-preview/`, `audit/_env-nombres-railway.md` en el backend; ya estaban y no son de este cambio.
