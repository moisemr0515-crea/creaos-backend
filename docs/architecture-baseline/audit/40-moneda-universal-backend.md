# 40 — Moneda universal (backend): un solo criterio, un solo formateador

Rama `fix/moneda-universal-backend` (desde `main` = `575e63b`). **Solo local: sin push, sin deploy, sin merge a `main`, sin migrar datos de Atlas.** Parte del diagnóstico del chat (tabla de hallazgos de moneda).

**Criterio único:** toda cantidad de dinero está en la moneda del NEGOCIO (`Business.currency`) y se escribe solo con el formateador `formatearImporte`. Sin casos especiales por pantalla, negocio, lead ni teléfono.

## Cambios (archivos tocados)
| Archivo | Cambio |
|---|---|
| `src/utils/money.js` (nuevo) | `formatearImporte(valor, moneda)` → `"500 PEN"`; sin moneda válida devuelve solo el número (nunca inventa USD); sin valor, `""`. Pura y sin locale. Incluye `normalizarMoneda`. |
| `src/modules/ai/ai.service.js` | «Valor potencial» y «Ticket promedio» del prompt usan `formatearImporte(…, business.currency)`. Antes: `$${valor} ${lead.currency \|\| 'USD'}` (línea 552). |
| `src/modules/missions/mission.service.js` | La línea «probabilidad, importe» de la Misión del día usa la moneda del negocio (antes `$… USD`). Se exporta `construirPromptDatos` solo para tests. |
| `src/modules/admin/reports.service.js` | CSV de leads y reporte de leads: la columna/campo `currency` sale de `Business.currency` (ya no de `lead.currency`). Se añadió la misma regla a `getLeadsReport`, que devolvía `currency` por lead (mismo defecto, no estaba en la lista). |
| `src/modules/leads/lead.model.js` | `Lead.currency`: `default` pasa de `'USD'` a `null` y queda documentado como **deprecado**. |
| `src/modules/products/product.service.js` | Comentario obsoleto («default 'MXN'») actualizado. |
| Tests (nuevos) | `src/utils/money.test.js`, `src/utils/money.guard.test.js`, `src/modules/businesses/moneda.universal.test.js` |

## Decisión sobre `Lead.currency` (punto 5)
**Opción tomada: ignorar el campo al leer** (y dejar de generar `'USD'` nuevos poniendo el default en `null`). No heredar la moneda del negocio al crear el lead porque:
1. Los leads antiguos ya guardan `'USD'` en Atlas y **no se migran**: de todos modos toda lectura tendría que ignorar el campo.
2. Heredar crearía una **segunda copia** de la moneda que se desfasa si el negocio cambia de moneda; con una sola fuente de verdad eso no puede pasar.
3. El frontend nunca envía moneda al crear un lead, así que el campo no contiene ninguna elección real de nadie.
El campo se conserva en el esquema y los validadores (compatibilidad), pero ninguna lectura de dinero lo usa.

## Pruebas (22 nuevas; suite completa **201 suites / 2003 tests verdes**, `git diff --check` limpio)
- **(a)** el prompt de un lead de un negocio PEN **no contiene `$` ni `USD`** (se comprobó que esa línea era la única del prompt con esos caracteres) y trae `Valor potencial: 500 PEN` y `Ticket promedio: 120 PEN`.
- **(b)** la misión y el reporte de un negocio PEN muestran PEN (`80% de probabilidad, 500 PEN`; columna `Moneda` = `PEN`; `getLeadsReport` → `currency: 'PEN'`).
- **(c)** un lead antiguo con `currency: 'USD'` (insertado directo en la base, como en Atlas) dentro de un negocio PEN se ve como PEN en prompt, misión, CSV y reporte. Con otra moneda de negocio (COP) se respeta; sin moneda no se inventa ninguna.
- Un lead nuevo ya no nace con `'USD'`; un negocio sin moneda legible exporta la columna vacía.
- **Guardia automática** (`money.guard.test.js`): recorre `src/` (sin comentarios ni tests) y falla ante `$${` o un código de moneda entre comillas (`'USD'`, `'MXN'`, `'PEN'`, `'COP'`, `'ARS'`, incluido `|| 'USD'`) fuera de esta lista corta de excepciones: `config/aiPricing.js` y `modules/admin/dashboard.service.js` (costos/MRR internos en USD), `modules/subscriptions/` y `database/seeds/plans.seed.js` (suscripción de CREA OS) y `modules/businesses/currencyByCountry.js` (tabla país→moneda). Otra prueba comprueba que cada excepción existe.
- **Controles negativos:** (1) reintroduje `lead.currency || 'USD'` a mano en `mission.service.js` → la guardia falló señalando `mission.service.js:270`; se restauró el archivo (0 restos). (2) Sin el arreglo de código, 9 de los 12 tests de moneda y la guardia fallan.

## Efecto en producción y límites
- **Sin migración ni variables.** Los leads viejos conservan `'USD'` en Atlas pero ya no se lee.
- Con esta rama, el agente de IA y la Misión del día hablan en la moneda del negocio. **Un negocio que todavía tiene `MXN` por el valor por defecto antiguo seguirá mostrando `MXN`** hasta que se cambie en «Mi negocio» (la decisión de qué hacer con esos negocios sigue pendiente, sin migrar).
- El formato es `500 PEN` (código ISO tras el número), pensado para texto que lee la IA o un reporte; la pantalla del frontend usa su propio formateador (rama `fix/moneda-universal-frontend`).
- No cubierto aquí: precios de planes/suscripción (`subscription.service.js`: conversión `price*1000` a ARS cuando falta `price_ars`) — dominio distinto, queda como pendiente.
- **No pude verificar:** el comportamiento con la IA real (los tests comprueban el texto del prompt, no la respuesta del modelo) ni datos reales de Atlas (cuántos leads/negocios hay con cada moneda).
