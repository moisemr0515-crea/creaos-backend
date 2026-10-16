# 37 — Despliegue reducido (backend): Etapa B (P1, P2), Etapa C. SOLO PREPARADO

Fecha: 2026-10-16 · **No hay push, no se tocó `main` (backend `5ad2aa9`), no se desplegó nada, no se consultó producción.** `integration/fase3-backend` quedó **intacta**. Todo en `C:\PROYECTOS\CREA-OS\`.
Etiquetas: **[CONFIRMADO]** (código/tests/git) · **[INFERIDO]** · **[DESCONOCIDO]** (vive fuera del repo y no pude mirarlo). Variables: solo nombres.

---

## 1. La rama `integration/fase3-slim-backend`

Creada desde `main` (`5ad2aa9`) con *cherry-pick* de 9 commits, **sin ningún conflicto**:

| Commit | Qué es | Alcance pedido |
|---|---|---|
| `bf64baf`, `0504c5a` | Tests de caracterización del diagnóstico (solo tests) | Soporte: las etapas B y C modifican ese archivo de tests |
| `25c7297` | Respaldo directo del PDF + degradación sin `chunk_vector_index` | Etapa C |
| `7180452` | Registro único de «Mi negocio», estado «listo» y `GET /businesses/current/ai-readiness` | Etapa C |
| `915c8c3` | `send_media` con 4 materiales (incluye fotos del negocio), prompt, tests de contrato | Etapa C |
| `834ac92` | Informe `audit/28` | Etapa C |
| `05f9089` | **P2**: la API no devuelve mensajes internos de herramientas | Etapa B |
| `d6dfc71` | **P1**: enlaces Markdown y negritas `**` a formato WhatsApp | Etapa B |
| `d549547` | Test: el filtro de P2 no afecta al historial que va al modelo | P2 |

**Fuera a propósito:** P4 (`22db6cd`), el informe `audit/29` (describe P4), el informe `audit/27` (solo documentación de la Etapa A) y los 2 commits del hotfix (ya están en `main`). Archivos de producción tocados: **11** (`ai.service.js`, `conversation.model.js`, `tools/index.js`, `documentFallback.service.js`, `knowledgeRetrieval.service.js`, `business.controller.js`, `business.routes.js`, `businessAssets.registry.js`, `businessReadiness.service.js`, `product.service.js`, `whatsappFormat.js`). **Ninguno** de Fase 0-1-2: sin sesión/refresh, sin límites 429, sin `CORS`, sin `policies/`, sin cambios de consentimiento, sin `server.js`/`worker.js`. Verificado: el único `consentPolicy` / `policies/` que aparece en el código son comentarios, y `src/modules/policies/` no existe en la rama.

---

## 2. P4: ¿se puede incluir sin traer Fase 2?

**No tal como está.** El commit de P4 (`22db6cd`) llama a `consentPolicy.resolveConsent(...)`, módulo (`src/modules/policies/consentPolicy.js` + `consentPolicy.config.js` + el cargador `consentLead.js`) que **nace en Fase 2**. Traerlo equivale a traer Fase 2. Por eso **queda fuera**.

### Qué protección se pierde
`generateReply` **no se detiene por sí mismo** ante un contacto en baja. Casos concretos donde el agente sigue generando una respuesta:
1. **Simulador del CRM** (`POST /ai/conversations/:id/message` → `aiService.chat`): con un contacto en baja genera la respuesta con OpenAI y la **guarda** en la conversación. **No se envía por WhatsApp**, pero cuesta tokens y deja un mensaje de la IA en el historial.
2. **Baja que llega mientras el agente ya trabaja** (después de que el worker de entrada decidió responder): la respuesta se genera y se guarda; luego el worker de salida la descarta (`skipped`). Efecto: tokens y un mensaje huérfano.
3. Cualquier llamador futuro que invoque `generateReply` sin pasar por el worker de entrada.

En los tres casos **nada llega al contacto** (ver siguiente punto). Lo que se pierde es coste y coherencia del historial, no cumplimiento.

### Qué sigue cubriendo `ef25d65` (ya en `main`) [CONFIRMADO leyendo el código de `main`]
- **Worker de entrada** (`inbound.worker.js`): `recordInboundConsent` devuelve `suppressed: true` mientras el contacto esté `OPTED_OUT` (la propia «BAJA» y **todo mensaje posterior**, porque una escritura voluntaria nunca reactiva una baja). Con `suppressed` el mensaje se guarda y notifica pero **no se llama al agente**. Antes de `ef25d65` solo cortaba el turno de la propia «BAJA».
- **Worker de salida** (`outbound.worker.js`): cada evento con `origin:'ai'` se reevalúa justo antes de enviar con intención `ai_automated`; si el contacto está `OPTED_OUT` queda `skipped` (`errorType: whatsapp_suppressed`). Un evento antiguo con intención `reactive` también se trata como `ai_automated` (**la IA no hereda la excepción humana**). Cubre texto **y** media (la herramienta de media marca `messageIntent: 'ai_automated'` desde `ef25d65`).
- Resultado: **ningún envío de la IA sale a un contacto en baja**, incluida la carrera descrita en el caso 2. Esta rama no toca nada de esto.

### Opción si la quieres después (no incluida)
Un «P4-lite» de ~10 líneas podría comprobar la baja en `generateReply` con `whatsappConsentService.canSendWhatsAppMessage({ messageIntent: 'ai_automated' })`, que **ya existe en `main`** (lo usa el worker de salida). Sería código distinto al revisado en `22db6cd`, así que no lo incluí sin tu decisión.

---

## 3. Verificaciones

| Verificación | Resultado |
|---|---|
| Suite completa (`--maxWorkers=2`) | **196 suites / 1941 tests verdes** en la segunda corrida. **La primera corrida tuvo 1 fallo**: `knowledgeRetrieval.semantic.test.js › sin texto…` por *timeout* de 5 s (carga de la máquina). Ese archivo pasa solo (14/14) y la segunda corrida completa pasó sin fallos. Lo trato como intermitente; el test no toca código cambiado en esta rama |
| `git diff --check main..HEAD` | limpio |
| Variables de entorno nuevas | **Ninguna**: el diff de código no contiene `process.env`/`env.*` añadidos; no cambia `env.js`, `railway*.toml`, `package.json` ni lockfile |
| Migraciones / índices / colecciones | **Ninguna.** El único modelo tocado (`conversation.model.js`) solo cambia `toJSON` (sin índices ni esquema). Sin seeds |
| Hotfix duplicado | **No.** Los commits del hotfix no están en la rama; el diff contra `main` no vuelve a tocar `inicioDelTramo`, `MAX_CONTENIDO_GUARDADO` ni el saneador (0 coincidencias) y esas piezas aparecen una sola vez en el archivo |
| `test.failing` que quedan | **5** (la rama reducida no incluye P3 ni P4): imagen de la IA en ⏳, baja durante el turno, texto de la IA sin ligar a su envío, `aiService.chat` sin cortar ante baja, runtime sin cortar ante baja. Los dos últimos son exactamente lo que cubriría P4 |

**Cambios de contrato frente a `main`** (todos invisibles para el frontend actual): `GET /ai/conversations/:id` deja de incluir `role:'tool'` ni asistentes vacíos con `toolCalls` (P2); el texto de la IA sale en formato WhatsApp (P1); `search_products` / `search_business_knowledge` añaden `catalogEmpty`, `documentStatus` y `documentFallback` solo cuando aplican; `send_media` acepta `business_photos` y `photo`. **Endpoint nuevo:** `GET /api/v1/businesses/current/ai-readiness` (permiso existente `businesses:read`, solo lectura, nadie lo llama aún).

---

## 4. ¿Necesita algo del frontend? **No: es solo backend.**
- El frontend actual (`main` `4aa9863`) funciona sin cambios: no consume nada nuevo, y P2 solo le quita los globos vacíos y el JSON del contacto.
- **No exige que exista el panel de Políticas/FAQ ni sus permisos.** La IA lee políticas y FAQ **desde la base de datos** con la herramienta `search_business_knowledge`, que no pasa por RBAC. El panel (`BusinessKnowledgeSection`) ya existe en `main` del frontend desde C.2; lo único que requiere permisos `policies:*`/`faqs:*` en `roles` es **crear/editar** políticas y FAQ desde la pantalla (§5). Si hoy no hay políticas ni FAQ cargadas, la IA degrada: responde con catálogo y PDF y lo dice con naturalidad.
- Sigue visible (cosmético, ya presente hoy): el reloj ⏳ en los mensajes de la IA.
- El tuteo de textos (`integration/fase3-frontend`) es independiente y **no forma parte de este despliegue**.

---

## 5. `roles.seed.js`

**Qué hace** [CONFIRMADO, `src/database/seeds/roles.seed.js`]:
1. Para cada uno de los 33 permisos del sistema, `findOneAndUpdate({ slug }, permiso, { upsert })` en la colección `permissions` (metadatos; **no** se usan para autorizar). Nota: `admin:read`, `admin:write`, `notifications:read` y `reports:export` existen en el código pero **no** están en esta lista de metadatos.
2. Para cada uno de los 7 roles del sistema (`superadmin, owner, admin, manager, sales, support, viewer`), `findOneAndUpdate({ slug, business: null }, { name, slug, permissions: ROLE_PERMISSIONS[slug], isSystem: true, business: null }, { upsert })` en `roles`. **Reemplaza el arreglo `permissions` completo** por el de `src/config/constants.js`.
3. No toca usuarios, negocios, roles personalizados por negocio (`business ≠ null`), ni datos de clientes.

**Cómo se aplica la autorización** [CONFIRMADO]: en cada petición `auth.middleware` carga al usuario con `populate('role', 'slug permissions')` y `checkPermission` busca el permiso en ese arreglo (el rol `superadmin` pasa siempre). Cambiar `roles` en la base **surte efecto de inmediato, sin reiniciar ni volver a iniciar sesión** [INFERIDO por el código; no probado].

**¿Idempotente?** **Sí**: es *upsert* con valores fijos; correrlo dos veces deja el mismo estado.
**¿Seguro en producción?** Con condiciones:
- Es una **escritura en producción**: requiere tu autorización expresa y la cadena de conexión de producción en la máquina que lo corre (secreto; no lo hago yo).
- **Efecto colateral:** no añade solo los 8 permisos; **alinea todos los roles del sistema con las constantes del código**. Si alguien editó a mano un rol del sistema en Atlas, esa edición se pierde; y si la última vez que se corrió fue antes de otros cambios en `constants.js` (el último fue el 12/sep/2026, justo el de `policies:*`/`faqs:*`), también se aplicarían esos. Se corre con el código desplegado (`npm run seed:roles`).
- No hay modo de ensayo (*dry-run*). No se ejecuta automáticamente al desplegar (solo `npm run seed`/`seed:roles` a mano).

**Alternativa más pequeña y reversible (no ejecutada, también con tu autorización)**, desde Atlas (mongosh o editor), solo añade lo que falta:
```js
// Owner, Admin, Manager: los 8 permisos
db.roles.updateMany(
  { isSystem: true, business: null, slug: { $in: ["owner", "admin", "manager"] } },
  { $addToSet: { permissions: { $each: ["policies:read","policies:create","policies:update","policies:delete","faqs:read","faqs:create","faqs:update","faqs:delete"] } } }
)
// Sales y Viewer: solo lectura
db.roles.updateMany(
  { isSystem: true, business: null, slug: { $in: ["sales", "viewer"] } },
  { $addToSet: { permissions: { $each: ["policies:read","faqs:read"] } } }
)
```
Reversa: la misma consulta con `$pull: { permissions: { $in: [ …los mismos… ] } }`. (`support` no recibe ninguno; `superadmin` pasa siempre.)

### Cómo comprobarlo en Atlas, sin leer datos de clientes
La colección `roles` solo contiene nombres de rol y *slugs* de permiso (los roles personalizados llevan el id de un negocio, **no los abras**).

**Atlas → Database → Browse Collections → (base de producción) → `roles` → caja «Filter».** Pega cada filtro, pulsa *Apply* y lee el número «of N» de arriba:

| # | Filtro | Resultado esperado (BIEN) | MAL |
|---|---|---|---|
| 1 | `{ "isSystem": true, "business": null }` | **7** roles: `superadmin, owner, admin, manager, sales, support, viewer` | menos de 7 ⇒ el seed nunca se corrió completo |
| 2 | `{ "permissions": "policies:read" }` | **6**: `superadmin, owner, admin, manager, sales, viewer` | 0 o menos ⇒ falta el permiso |
| 3 | `{ "permissions": "faqs:read" }` | **6** (los mismos) | idem |
| 4 | `{ "permissions": { "$all": ["policies:create","policies:update","policies:delete","faqs:create","faqs:update","faqs:delete"] } }` | **4**: `superadmin, owner, admin, manager` | menos ⇒ no pueden crear/editar/archivar desde el panel |
| 5 | `{ "isSystem": true, "business": null, "permissions": { "$nin": ["policies:read"] } }` | **1**: `support` | si salen los 7 ⇒ **nadie** tiene los permisos |

Para ver solo los nombres y no el resto, en *Options* → *Project* pon `{ "slug": 1 }`. Opcional (solo informativo, no se usa para autorizar): en `permissions`, filtro `{ "slug": { "$regex": "^(policies|faqs):" } }` ⇒ **8** documentos.
Si el 2 y el 3 dan 6 y el 4 da 4: **los permisos existen y no hace falta correr nada.**

---

## 6. Despliegue, prueba de humo y reversa

**Qué desplegar:** una sola fusión en `main` (`git merge --no-ff integration/fase3-slim-backend`, recomendado por la reversa) y un `push`. Railway despliega **API y worker a la vez** (sin variables que poner antes: no hay variables nuevas). La lógica de la IA por WhatsApp corre en el **worker** (P1, Etapa C); P2 y `ai-readiness` viven en la **API**: **los dos servicios deben quedar en el mismo commit**.

**Paso 0 (lectura, antes):** anota el commit activo de `creaos-backend` y `creaos-backend-worker` (debería ser `5ad2aa9`). `/health` de ambos en verde. Elige un número tuyo de prueba (con permiso) y uno desechable para la baja. Con el frontend actual sube al tenant de prueba (CREA OS) 2 fotos del negocio, un video y un brochure.

**Prueba de humo con WhatsApp real (tenant CREA OS):**
| Mensaje | Esperado | Si falla |
|---|---|---|
| «Hola, ¿qué productos tienen?» | Responde **sin** `**` ni `[texto](url)` (P1) | ¿worker en el commit nuevo? |
| «Mándame el video de presentación», y al llegar: «Gracias» | Llega el video **y** la IA responde (el hotfix sigue funcionando) | Reversa |
| «Mándame fotos de la empresa» y luego «la otra» | Llegan la foto 1 y la 2 | Estado de la foto en `ai-readiness`; volver a subirla |
| «Mándame el logo» / «el catálogo en PDF» | Llegan | Comprobaciones de producción (#1–#7 del chat) |
| Pregunta por algo que **no está en el catálogo pero sí en el PDF** | Responde con datos del documento | Estado del PDF / índice; con esta rama degrada al respaldo |
| Desechable: «BAJA» y luego «hola» | La IA **no** responde (log `suppression WhatsApp activa`) — **verifica que `ef25d65` sigue activo; esta rama no lo toca** | Reversa y avisarme |
| Abrir esa conversación en el CRM | Sin globos vacíos ni JSON del contacto (P2) | Reversa |
| Contactos normales | Siguen respondiendo igual | Reversa |
Opcional (técnico): `GET /api/v1/businesses/current/ai-readiness` con un token de Owner devuelve el estado por sección.

**Reversa exacta (sin migraciones ni variables que deshacer):**
1. Railway → cada servicio → *Deployments* → redesplegar el de `5ad2aa9` (**en los dos servicios**).
2. Por git: `git revert -m 1 <commit de fusión>` y push (con *fast-forward*: `git revert --no-edit 5ad2aa9..HEAD`).
Lo guardado con el código nuevo es válido para el anterior (P2 solo cambia lo que devuelve la API; el recorte `…[recortado]` del hotfix ya está en `main`). **No bajar de `5ad2aa9`** (reabre el bug de las conversaciones envenenadas). **No hay punto sin retorno**: lo único irreversible son los WhatsApp ya entregados.

---

## 7. Lo que NO pude verificar
1. **Railway:** qué commit corre cada servicio hoy, si ambos redesplegaron con el hotfix y si los dos despliegan desde `main`.
2. **Atlas:** si los permisos `policies:*`/`faqs:*` existen hoy en `roles` (§5 da los filtros); si `chunk_vector_index`, `policy_vector_index` y `faq_vector_index` existen y están `READY` (con esta rama, si faltan, la IA usa el PDF como respaldo; las políticas/FAQ quedan solo con búsqueda por texto).
3. **WhatsApp real:** que Meta acepte los enlaces firmados de Cloudinary (imagen y PDF) y el comportamiento de la conversión de formato con mensajes reales. Todos los tests usan OpenAI, Gupshup, Redis y Atlas simulados.
4. Que el tenant de CREA OS tenga video/fotos/brochure en el formato nuevo (condiciona las pruebas de media).
5. La intermitencia del test de *timeout* (§3): la corrí dos veces; no investigué más a fondo.
6. No probé `roles.seed.js` ni las consultas de `roles` (requieren acceso a producción); la lectura de su comportamiento es por código.
7. Con esta rama, un «BAJA» enviado por **botón/respuesta rápida** de una plantilla sigue sin registrarse (eso es Fase 2: no está incluido).
