# 41 — Herramientas de la IA: ids de producto, etapas del pipeline y "nunca inventar" tras un error

Rama local `fix/ia-herramientas`, desde `main` = `d0f1db2` (origin/main = `575e63b`). Solo backend. Sin migraciones, sin variables nuevas, sin frontend. **No está en producción.**

## Qué pasó en producción (NUTRIVA, worker)

1. `get_price` → `Cast to ObjectId failed for value "aceite_de_moringa_qhali_kausay"`. El modelo armó un id a partir del nombre del producto y el código lo mandó tal cual a Mongo.
2. `update_lead_stage` → `"stage" debe ser uno de [new, contacted, negotiating, won, lost]`. La tool le sugería etapas "típicas" (`interested`, `proposal`, `negotiation`) que ese negocio no tiene.

Los dos errores ya existían en `575e63b`; no los introdujo la moneda (`d0f1db2`).

## Los tres arreglos (un commit cada uno)

| # | Commit | Qué cambia | Archivos de código |
|---|--------|-----------|--------------------|
| 1 | `73596d5` | **Ids de producto.** `resolverProductId` valida que el id sean 24 hex (no `mongoose.isValidObjectId`, que acepta cualquier texto de 12 caracteres). Id inválido → se usa el producto activo de la conversación; si no hay, error claro («usa el productId exacto de `search_products`»), sin texto de Mongo. `variantId` inventado se trata como no enviado. `search_business_knowledge` descarta `productIds` inválidos. El bloque «CONTEXTO DE PRODUCTO» del prompt ahora trae el `productId` real. | `ai/tools/index.js`, `ai/ai.service.js` |
| 2 | `e069c0e` | **Etapas del pipeline.** `construirToolSchemas({business, lead})` (una vez por turno) pone en `update_lead_stage.stage` un `enum` con las claves del pipeline efectivo del lead y nombra cada etapa en la descripción. Si no se puede leer el pipeline, quedan los schemas genéricos de siempre (`TOOL_SCHEMAS` no cambia, byte a byte). El log de un fallo de tool agrega `\| args: {...}` solo con campos que arma el modelo (`stage`, `productId`, `variantId`, `resource`, `photo`), recortados; nunca `query` ni `reason`. La validación del servidor sigue igual. | `ai/tools/index.js`, `ai/ai.service.js` |
| 3 | `a1434b8` | **Nunca inventar tras un error.** Toda tool que lanza devuelve además `aviso` (no inventes ni afirmes como confirmado lo que la tool no devolvió; di que lo verificarás; si el error indica cómo corregir, reintenta). Prompt: párrafo «FALLO TÉCNICO DE UNA HERRAMIENTA»: si `get_price`/`check_stock` fallan sobre un producto que `search_products` sí encontró, **no** se usa `documentFallback` ni el PDF para precio o stock; se reintenta una vez y, si sigue, se dice de forma natural sin dar número. Fuera del catálogo el documento sigue valiendo (Etapa C intacta). | `ai/tools/index.js`, `ai/ai.service.js` |

## Pruebas nuevas (3 archivos, 55 pruebas)

- `ai/tools/index.productIds.test.js` (24): slug, 12 caracteres, JSON de inyección, texto enorme; con y sin producto activo; `variantId`; `search_business_knowledge`; aislamiento por negocio; **contrato sobre `TOOL_REGISTRY`** (todo parámetro `*Id`/`*Ids` rechaza basura sin filtrar errores de Mongo, ni log de error); el prompt incluye el `productId`.
- `ai/tools/index.updateLeadStage.test.js` (16): etapa inválida (trae la lista real), log con la etapa intentada y sin texto del cliente, etapa válida, misma etapa, pipeline propio, enum dinámico por negocio (dos negocios → dos enums), fail-soft, **contrato sobre el parámetro `stage` de `TOOL_REGISTRY`**, flujo completo con OpenAI simulado (el modelo se equivoca, recibe la lista, reintenta y el lead avanza).
- `ai/ai.service.generateReply.toolFallida.test.js` (15): aviso en todo error (**contrato: las 8 tools de `TOOL_REGISTRY`**), regla nueva del prompt y Etapa C conservada, **flujo completo con OpenAI simulado tras un `get_price` fallido** (el modelo recibe error + aviso, ningún precio, ningún `documentFallback`, y el PDF —que dice S/ 999— nunca entra al turno) y el caso exacto de producción (slug tras buscar el producto → precio real del catálogo, sin error en el log).

## Control negativo (cada prueba nueva falla sin su arreglo)

Se dejaron las pruebas nuevas y se restauró el código del commit anterior a cada arreglo:

| Arreglo | Sin el arreglo | Con el arreglo |
|---------|----------------|----------------|
| 1 (ids) | 20 de 24 fallan | 24 / 24 |
| 2 (etapas) | 8 de 16 fallan | 16 / 16 |
| 3 (no inventar) | 14 de 15 fallan | 15 / 15 |

Las que pasan sin el arreglo son guardias de regresión de comportamiento que ya era correcto (un id real sigue ganando al activo, un negocio ajeno sigue sin exponer datos, etapa válida/misma etapa, contratos no vacíos, y el caso del slug en el arreglo 3, que ya lo resolvía el arreglo 1).

## Resultados

- Suite completa en `a1434b8`: **204 / 204 suites, 2058 / 2058 pruebas en verde** (`npx jest --maxWorkers=2`). Base `d0f1db2`: 201 suites / 2003 pruebas; la rama suma 3 suites y 55 pruebas.
- Con la configuración por defecto (todos los procesos en paralelo) falla `businessAssets.registry.contract.test.js` por un `beforeAll` que excede 5 s (conexión + `syncIndexes`) bajo carga. **No es de esta rama:** la base `d0f1db2` falla igual (21 pruebas, el mismo archivo y el mismo `beforeAll`), y ese archivo pasa 52/52 solo y con 2 procesos. Es una fragilidad de tiempo de la prueba, pendiente de revisar aparte.
- `git diff --check`: limpio.

## Límites y riesgos (leer antes de desplegar)

- **No se puede probar qué decide decir el modelo real**, solo lo que recibe (resultado de la tool y prompt). La regla del prompt reduce el riesgo de que cite el precio del PDF tras un fallo técnico, no lo garantiza.
- `construirToolSchemas` usa `obtenerPipelineEfectivo`, que si el negocio no tiene pipeline **lo crea** (el mismo comportamiento que ya tiene `cambiarEtapa` y `crearLead`); no es una escritura nueva en el sentido de datos, pero ocurre un turno antes que antes. Añade una lectura de Mongo por turno de IA.
- El `enum` de OpenAI no es estricto: el modelo todavía podría mandar otra etapa; sigue valiendo la validación del servidor (que devuelve la lista real).
- Con un id inventado y un producto activo, se usa el producto activo (el último que dejó `search_products`). Si el lead cambió de tema sin buscar de nuevo, podría ser otro producto: el mismo riesgo que ya existía al omitir el `productId`.
- El error de «falta el productId» (sin id y sin producto activo) no lleva `aviso` (una prueba existente fija su forma exacta); el prompt cubre ese caso.
- No toca producción ni datos. **Reversa** (si algún día se despliega): `git revert -m 1 <merge>` o Redeploy del commit anterior en Railway (API y worker).
