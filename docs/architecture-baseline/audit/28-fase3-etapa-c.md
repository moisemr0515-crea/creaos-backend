# 28 — FASE 3, ETAPA C: PDF de conocimiento, material enviable y contrato anti-rotura de «Mi negocio»

Rama `fase3/rag-media-c` (desde `fase3/rag-media-diagnostico`: `fase3/rag-media-fixes` no existe). Solo local: sin push, sin deploy, sin merge a `main`, sin Android, sin producción, sin secretos. `main` intacto (backend `b570131`, frontend `4aa9863`).

Commits de esta etapa (en orden):

| Commit | Contenido |
|---|---|
| `adc97a2` | Respaldo directo del PDF (`documentFallback.service`), degradación sin índice vectorial en `knowledgeRetrieval`, `contarProductosActivos` |
| `87a3720` | Registro único `businessAssets.registry.js`, `businessReadiness.service.js` y `GET /businesses/current/ai-readiness` |
| `eb76107` | Tools (`send_media` sobre el registro, fotos del negocio, respaldo del PDF), prompt, tests de contrato y 3 casos de la Etapa A actualizados |

Regla universal respetada: ninguna rama del código mira un teléfono, un lead o un negocio concreto. Todos los tests corren con 2 negocios ficticios distintos.

---

## 1. Conocimiento (P5): el PDF ya no depende del índice vectorial

### Qué cambia
| Situación | Antes | Ahora |
|---|---|---|
| `search_products` no encuentra el producto, o el catálogo está vacío | `{success:true, matches:[]}`; la IA no tenía el PDF | Igual **más** `documentFallback` (chunks activos que coinciden + texto extraído del PDF ≤ 4000) y `catalogEmpty:true` si no hay ningún producto activo |
| Falta `chunk_vector_index` (o `$vectorSearch` falla) | `search_business_knowledge` fallaba **entera** (se perdían también políticas y FAQ) | `knowledgeRetrieval.resolverConocimiento` captura solo `RAG_VECTOR_INDEX_UNAVAILABLE`, registra un `warn`, devuelve políticas/FAQ y `documentIndexAvailable:false`; la tool agrega `documentStatus:'indice_no_disponible'` y el `documentFallback` |
| El índice existe pero no devuelve fragmentos | Sin PDF | `documentStatus:'sin_resultados'` + `documentFallback` |
| No hay PDF ni catálogo | `{success:true, matches:[]}` | `{success:true, matches:[], catalogEmpty:true}`; en conocimiento, arrays vacíos (la forma de siempre) |

`buscarChunksDocumento` **sigue fallando cerrado** por sí misma (otros llamadores no cambian); el único punto que decide degradar es `resolverConocimiento`.
El respaldo (`documentFallback.service.js`) lee de Mongo, nunca lanza, filtra por `business` y `active:true` (aislamiento por tenant probado) y rankea por palabras clave (sin tildes, sin palabras vacías).

### Precedencia (decisión del dueño) — en prompt y en código
- El producto **existe** en el catálogo ⇒ el catálogo manda en precio y stock (`get_price`/`check_stock`); la barrera `priceStockGuard` sigue descartando fragmentos que lo contradicen.
- El producto **no existe** (o catálogo vacío) ⇒ la IA puede usar el PDF, aclarando que sale del documento y que el equipo puede confirmarlo.
- Cambios de prompt (`ai.service.js`): bloque `PRECEDENCIA ENTRE CATÁLOGO Y DOCUMENTO`; `documentChunks` ya no es «SOLO información general» sino «también productos que NO están en el catálogo; NUNCA precio/stock de uno que SÍ existe»; instrucción de usar `documentFallback` cuando falta el índice, **sin mencionar errores técnicos**; el PDF informativo **nunca se envía**.

### «Conocimiento listo / no listo» por negocio
`GET /api/v1/businesses/current/ai-readiness` (permiso `businesses:read`, solo lectura, el negocio sale de `req.businessId`). Devuelve por cada fuente del registro `loaded` / `connected` / `state` / `count` / `missing[]` / `warnings[]` y un resumen `ready.knowledge` / `ready.material`. Estados del PDF: `READY` (documento `active` con chunks), `PROCESSING`, `DEGRADED` (sin índice pero con texto: la IA usa el respaldo), `FAILED` (sin texto legible, p. ej. PDF escaneado: avisa «sube un PDF con texto»), `EMPTY`. **No se tocó ninguna pantalla** en esta etapa.

---

## 2. Material enviable (P6–P7): traza completa y por qué solo salía el video

### 2.1 Traza de punta a punta (idéntica para los 4 tipos desde el registro hasta el proveedor)
```
Lead pide el archivo
 → modelo llama send_media {resource[, photo]}                 (ai/tools/index.js, TOOL_REGISTRY)
 → businessAssets.resolverEnviable(business, resource, {photo}) (businesses/businessAssets.registry.js)  ← ÚNICO punto por tipo
     → entry.url(): businessAssetAccess.obtenerUrlDeAcceso / obtenerUrlDeAccesoFoto
         • *Asset privado (Cloudinary 'authenticated') → private_download_url firmada, 48 h ('send')
         • *Asset con storageKey (documentStorage/S3) → URL prefirmada (brochure)
         • solo URL heredada (sin *Asset) → tipoEntrega 'upload' → null → asset_missing
 → validarPuedeEnviarMedia (WhatsApp, lead con teléfono, ventana 24 h, canal activo)
 → persistAndEnqueueAiMedia → OutboundEvent {origin:'ai', messageIntent:'ai_automated', messageType:'media', payload.media:{url,type[,filename]}}
 → outbound.worker (vuelve a validar aiEnabled/consentimiento/entitlement) → GupshupProvider.sendMedia
     • Partner v3 (outboundApi:'partner' + providerAppId): POST /partner/app/{appId}/v3/message
         {messaging_product:'whatsapp', recipient_type:'individual', to, type, [type]:{link, caption?, filename? (solo document)}}
     • Legacy (/wa/api/v1/msg): imagen {originalUrl,previewUrl}, video {url}; **document → 501**
```
Evidencia: `gupshupProvider.js` (`sendMedia`), `gupshup.partner.client.js` (`sendMediaMessage`), `businessAssetAccess.service.js`, `utils/cloudinaryAssetAccess.js`; tests `businessAssets.registry.contract.test.js` (sección «(b) ENVIA») recorren la tool real y arman el body Partner real con `fetch` simulado para logo, fotos 1 y 2, video y brochure.

### 2.2 Por qué «solo salía el video» — lo que el código demuestra y lo que no
Demostrado con código y tests:
1. En el camino **Partner** logo, video y brochure son **simétricos**: misma resolución, mismo evento, mismo cliente. El código no trata al video mejor que al resto.
2. **Business.photos no existía en la tool**: `send_media` solo conocía `logo`, `presentation_video`, `brochure`; las «fotos del negocio» nunca eran enviables (y `send_product_photos` solo mira `Product.mediaAssets`). *Corregido (§2.3-a).*
3. Un **logo o brochure con solo URL heredada** (cargado antes de la migración a `*Asset` privado) no genera URL firmada ⇒ `asset_missing`. El estado «listo» ahora lo marca `NOT_SENDABLE` y pide volver a subirlo. Un video subido ya con `presentationVideoAsset` sí sale.
4. En un canal **Legacy** (`connectionType:'PLATFORM'` o `outboundApi` distinto de `partner`) un **documento** (brochure) devuelve 501 por diseño; imagen y video sí salen.

No demostrable sin producción (ver §6): en qué estado están realmente `logoAsset`/`brochureAsset`/`photoAssets` del negocio afectado, si ese canal es Partner o Legacy, y si Meta acepta los links `private_download_url` de Cloudinary para PDF (`raw`) e imagen. **No se adivinó ninguna causa**: lo externo queda como caracterización + lista de comprobaciones.

### 2.3 Cambios
a) **Fotos del negocio enviables**: `send_media(resource:"business_photos", photo:1|2)`; dos fotos distintas, anti-spam por foto (`mediaKey` `business:photo:N`), `asset_missing` si no hay.
b) **Logo/brochure**: sin cambios de código en la ruta de envío porque el código no los bloquea (§2.2-1); lo que sí se hizo: el estado «listo» detecta el caso real (URL heredada ⇒ no enviable) y los límites de WhatsApp por tipo quedan declarados en el registro (imagen 5 MB `jpeg/png/webp`; video 16 MB `mp4/3gpp`; documento 100 MB `pdf`) con avisos de `mimeType`/`size` en el estado. El `filename` del brochure ya viajaba al payload (`brochureFilename`) y ahora está cubierto por test.
c) **Un solo punto**: `resolverEnviable` en el registro; `send_media` perdió sus `if` por tipo y su enum sale del registro (el test falla si divergen).
d) **La tool y su descripción cubren los 4 tipos** (logo, business_photos, presentation_video, brochure) y el prompt (`MEDIA_GUIDANCE`) indica cuándo usar cada uno y que el PDF informativo no se envía.

---

## 3. Contrato anti-rotura (`businessAssets.registry.js`)

| Familia | Sección de «Mi negocio» | Origen (colección → campos) | Consumidor en el camino del agente | Límites |
|---|---|---|---|---|
| LEE | Instrucciones para tu IA | `businesses` → `aiInstructions`, `aiPersonality` | prompt `buildSystemPrompt` («INSTRUCCIONES ESPECÍFICAS DEL DUEÑO») | texto |
| LEE | Base de conocimiento (PDF informativo) | `businesses` → `pdfUrl`, `pdfAsset`, `pdfExtractedText`, `pdfSummary`; `businessdocuments`, `businessdocumentchunks` | prompt (resumen) · `search_business_knowledge` · `search_products` (`documentFallback`) | PDF ≤ 10 MB, nunca se envía |
| LEE | Inventario y catálogo | `products` → `name, description, price, physicalStock, keywords, synonyms, active` | `search_products`, `check_stock`, `get_price` | ≤ 5 resultados |
| LEE | Políticas | `policies` → `title, statement, customerFacingText, status` | `search_business_knowledge` | solo `active` |
| LEE | Preguntas frecuentes | `faqs` → `question, answer, status` | `search_business_knowledge` | solo `active` |
| ENVÍA | Logo | `businesses` → `logo`, `logoAsset` | `send_media(logo)` → imagen | 5 MB, jpeg/png/webp |
| ENVÍA | Fotos del negocio | `businesses` → `photos`, `photoAssets` | `send_media(business_photos, photo)` → imagen | 1–2, 5 MB |
| ENVÍA | Video de presentación | `businesses` → `presentationVideoUrl`, `presentationVideoAsset` | `send_media(presentation_video)` → video | 16 MB, mp4/3gpp |
| ENVÍA | Brochure | `businesses` → `brochureUrl`, `brochureFilename`, `brochureAsset` | `send_media(brochure)` → documento | 100 MB, pdf |
| ENVÍA | Fotos de producto del catálogo | `products` → `mediaAssets` | `send_product_photos` → imagen | 1 foto (la principal) por envío |

### Tests de contrato (`businessAssets.registry.contract.test.js`, 52 casos = 10 estáticos + 21 de comportamiento × 2 negocios)
- **(c) estático**: todo campo de `Business` cuyo nombre sugiera logo/foto/pdf/brochure/video/asset/instrucciones/personalidad debe estar en `CAMPOS_DE_BUSINESS` o en `NO_ALIMENTAN_A_LA_IA` (con motivo) y viceversa (sin campos fantasma); el único campo de media de `Product` es `mediaAssets`; las listas LEE/ENVIA quedan fijadas; cada consumidor `tool` existe en `TOOL_REGISTRY`; cada consumidor `prompt` aparece de verdad en `buildSystemPrompt`; el enum de `send_media` sale del registro; cada LEE tiene evaluador de «listo». *Agregar un campo o sección sin registrarla rompe el test.*
- **(a) LEE**: negocio de prueba con instrucciones, PDF (resumen, texto y chunk), producto, política y FAQ ⇒ cada fuente llega por su consumidor real y devuelve contenido (incluida la degradación del PDF sin índice, que en Mongo local es el caso real).
- **(b) ENVÍA**: logo, foto 1, foto 2, video y brochure ⇒ la tool real crea el `OutboundEvent` con el tipo correcto (`image/image/image/video/document`), URL firmada con `expires_at` (no pública), `filename` del brochure, y el cliente Partner arma el body de Gupshup correcto. Además: sin nada cargado ⇒ `asset_missing`; solo URL heredada ⇒ no enviable (y el estado lo dice); `pdf` no es un recurso enviable; fotos de catálogo ⇒ imagen.
- **(d) 0 datos**: negocio vacío ⇒ ninguna tool falla, `catalogEmpty:true`, arrays vacíos y el estado enumera qué falta por sección; con datos ⇒ `ready` verdadero; PDF sin índice ⇒ `DEGRADED`; PDF escaneado ⇒ `FAILED` con motivo; aislamiento entre negocios.
- Otros: `documentFallback.service.test.js` (puras + Mongo + aislamiento), `business.controller.aiReadiness.test.js` (ruta con permiso, solo lectura, 404), `ai.service.buildSystemPrompt.etapaC.test.js` (precedencia, respaldo, 4 materiales, PDF no se envía).

---

## 4. Estado de los `test.failing` de la Etapa A
Ninguno de los 7 `test.failing` se arregla en esta etapa (corresponden a estado del mensaje/⏳, burbuja vacía, baja durante el turno, formato Markdown y agente tras la baja: Etapas B y siguientes). Siguen verdes como «fallo esperado».
Tres casos de **caracterización** (no `failing`) cambian **por diseño** y se actualizaron en el mismo commit:
1. Recurso desconocido de `send_media` ahora lista `logo, business_photos, presentation_video, brochure`.
2. `search_business_knowledge` sin índice vectorial **ya no falla entera** (`success:true`, políticas/FAQ vacías, `documentStatus:'indice_no_disponible'`).
3. El texto del prompt sobre `documentChunks` (nueva precedencia).

---

## 5. Riesgos y decisiones a revisar
- `search_products` ahora hace dos lecturas extra (chunks del negocio, conteo de productos) **solo cuando no hay coincidencias**; coste acotado (≤ 300 chunks, `select` mínimo).
- El respaldo es **léxico**, no semántico: con sinónimos o consultas muy distintas del texto puede no encontrar el fragmento; en ese caso entrega el texto extraído (≤ 4000 caracteres), no nada.
- Un PDF muy largo (> 5000 caracteres extraídos) solo conserva ese tramo en `pdfExtractedText` (límite del modelo existente); lo que queda fuera solo se alcanza por los chunks/índice.
- `tools/index.js` y `ai.service.js` mezclan conocimiento y material en el mismo archivo; por eso van juntos en el tercer commit.
- El estado «listo» calcula la URL firmada (operación local, sin red ni escritura) para decidir si algo es enviable: así coincide exactamente con lo que haría la tool.
- Sin cambios de pantalla ni de esquema: **no hay migración**.
- Contradicción con el Baseline: ninguna nueva detectada. Pendiente de siempre (no tocado): `normalizeToE164` asume Perú.

---

## 6. Qué NO pude verificar sin producción (datos exactos para el dueño — solo lectura)

**Atlas (base de producción, solo `find`/`countDocuments`/`getIndexes`, sin leer texto de documentos):**
1. Colección `businessdocuments` del negocio afectado (filtro por su `business`): `status`, `errorCode`, `error`, `attemptCount`, `chunkCount`, `version`, `updatedAt`.
2. Colección `businessdocumentchunks` (mismo `business`): cantidad con `active:true` y `embedding.length` de uno (esperado 1536).
3. Search Indexes de `businessdocumentchunks`: ¿existe `chunk_vector_index`? ¿estado `READY` y dimensión 1536, filtros `business` y `active`? (si no existe, **este cambio ya hace que la IA use el respaldo**, pero conviene crearlo).
4. Colección `products` del negocio: cuántos `active:true`, cuántos con `price`, cuántos con `mediaAssets.0`.
5. Colección `businesses` del negocio, **solo presencia/forma** (sin URLs ni IDs): `logo`/`logoAsset` (¿existe `logoAsset.publicId`? `deliveryType`, `resourceType`, `mimeType`, `size`), `photos`/`photoAssets`, `presentationVideoAsset`, `brochureUrl`/`brochureAsset` (¿`publicId` o `storageKey`?), `brochureFilename`, y `pdfExtractedText`/`pdfSummary` (**solo longitud**).
6. Colección `whatsappchannels` del negocio: `connectionType`, `outboundApi`, presencia de `providerAppId` (decide Partner vs Legacy; Legacy ⇒ el brochure da 501).
7. Colección `outboundevents` (`origin:'ai'`, `messageType:'media'`) del negocio: `status`, `errorType`, `providerStatus`, `attemptCount` de los últimos envíos de logo/foto/brochure — dice si Gupshup/Meta los rechazó y con qué error.

**Cloudinary (consola, solo lectura):**
8. Para el `publicId` del brochure y del logo (carpetas `creaos/businesses/<businessId>/brochure|logo`): `resource_type` (`raw` para PDF), `type` (`authenticated`), `format` y tamaño. Si el PDF está como `raw` y el `public_id` ya incluye `.pdf`, la URL firmada que construye el código (`public_id` + `format:'pdf'`) podría duplicar la extensión.
9. Si la cuenta **bloquea la entrega de PDF/ZIP** (Settings → Security → «PDF and ZIP files delivery», opción «Allow delivery of PDF and ZIP files»). Si está desactivada, un PDF firmado devuelve 401/403 aunque el código sea correcto: sería la causa externa del brochure.
10. Abrir una URL `private_download_url` recién generada (la de un `OutboundEvent`, no compartirla) y confirmar el `Content-Type` real (`application/pdf`, `image/*`, `video/*`) y que responde 200 **sin** `Content-Disposition: attachment` que Meta rechace.

**Meta/Gupshup:**
11. Que Meta acepte como `link` una URL firmada de Cloudinary con parámetros largos (límite de longitud, redirecciones) para imagen y documento; el `providerStatus`/`errorType` del punto 7 lo muestra.
12. Prueba real con un tenant nuevo: subir logo, 2 fotos, video, brochure y PDF desde «Mi negocio», y pedirlos por WhatsApp (queda pendiente, igual que el autoservicio de WhatsApp).

---

## 7. Qué NO se tocó
`main`, el frontend, el esquema de Mongo, las colas, el worker de salida, la política de consentimiento, `normalizeToE164`, la rama `integration/fase2-*`, ningún dato de producción, ningún `.env`. Los dos archivos sin seguimiento `.email-preview/` y `audit/_env-nombres-railway.md` ya existían y no son parte de esta etapa.

## 8. Cierre de verificación
- Suites afectadas (businesses, ai, business-knowledge, channels/workers/fase3): verdes.
- Suite completa `npx jest --maxWorkers=2 --silent`: **210 suites / 2377 tests, todos verdes** (exit 0).
- `git diff --check`: limpio.
