# 43 — Estadísticas en el servidor (rama 3)

Rama local `feat/stats-servidor`, desde `feat/registro-ventas` (`d27c20b`). Solo backend. **No toca la IA ni el frontend.** No está en producción. Depende de la rama 1 (`sales`), que debe desplegarse antes o junto con esta.

## Qué hace
`GET /api/v1/stats/summary?period=this_month|last_month|custom&from=AAAA-MM-DD&to=AAAA-MM-DD`, con permiso `reports:read` (Owner, Admin, Manager y Viewer; **Sales y Support quedan fuera**: `sales` no guarda vendedor y no se podría acotar a «solo sus ventas»). Todo se calcula en el servidor, sin el tope de 20 leads, y solo con el negocio del token.

| Bloque | Qué es | De dónde sale |
|---|---|---|
| `vendido` | ventas **confirmadas con monto > 0** cerradas en el periodo (por `closedAt`): total, cantidad, promedio y última venta **por moneda**, con el periodo anterior (`previous`) | `sales` |
| `porConfirmar` | ventas pendientes, por moneda (de cualquier fecha: es trabajo por resolver) | `sales` |
| `sinMonto` | `ganadosSinVenta` (leads en etapa ganada sin ninguna venta confirmada) + `ventasConMontoCero` (confirmadas en 0). De cualquier fecha: es trabajo por registrar | `leads` + `$lookup` a `sales` |
| `enConversaciones` | leads abiertos: cantidad, total potencial, valor esperado, listos para cerrar y top 5 (solo con valor esperado > 0), en la moneda del negocio | `leads` |

- **Monedas mezcladas:** cada moneda va por separado, nunca se suman entre sí; una venta sin moneda queda aparte (`currency: null`). `businessCurrency` indica cuál es la del negocio.
- **Monto 0:** se guarda como venta pero no cuenta como «Vendido»; aparece en `sinMonto`.
- **Etapas sin casos fijos:** «ganado» y «abierto» se calculan con las etapas `isWon`/`isLost` del pipeline de **cada lead**. Un lead sin pipeline (o con uno inactivo) cuenta como del pipeline por defecto; si el negocio aún no tiene ninguno, valen las etapas por defecto y **no se crea nada** (es una lectura).
- **Valor esperado:** la fórmula de `pipeline.service.js` (ahora exportada como `EXPR_PROBABILIDAD`: `closeProbability`, o la temperatura si falta), redondeando por lead como la pantalla. «Listos para cerrar»: caliente o probabilidad ≥ 70.
- **Abiertos** excluyen ganados, perdidos, archivados y borrados.

## Zona horaria
- Los periodos se miden en `Business.settings.timezone` (`utils/timezone.js`, solo con `Intl`): «este mes» empieza a las 00:00 del día 1 **en la zona del negocio**. Una venta del 30 de septiembre a las 23:59 en Lima ya es 1 de octubre en UTC, y se cuenta en septiembre.
- `this_month` / `last_month` usan meses de calendario; el periodo anterior de cada uno es el mes de calendario previo. `custom` incluye ambos días y compara con el tramo de igual duración justo antes (máximo 366 días; fechas reales, `from` ≤ `to`, si no 400).
- **Valor por defecto para negocios NUEVOS derivado del país** (`businesses/timezoneByCountry.js`): Perú → `America/Lima`, México, Colombia, Argentina, Ecuador, Panamá y El Salvador con la suya; un país fuera de la tabla (o con varias zonas, como US) queda en `null`, sin zona inventada. Antes todos nacían en `America/Mexico_City`.
- **No se escribe nada en negocios existentes.** Un negocio ya creado conserva lo que tenga guardado (lo más probable es `America/Mexico_City`). Para NUTRIVA hay que fijarlo a mano: `PUT /api/v1/businesses/settings` con `{"timezone":"America/Lima"}`.
- Sin zona válida, Estadísticas usa UTC y lo avisa en la respuesta (`period.timezone`, `period.timezoneConfigured`).

## Archivos
- Nuevos: `src/modules/stats/` (`stats.service.js`, `stats.period.js`, `stats.validator.js`, `stats.controller.js`, `stats.routes.js` y 3 archivos de prueba), `src/utils/timezone.js`, `src/modules/businesses/timezoneByCountry.js` (+ pruebas de ambos).
- Modificados: `src/app.js` (monta `/api/v1/stats`), `src/modules/businesses/business.model.js` (default de `settings.timezone`), `src/modules/pipeline/pipeline.service.js` (solo exporta `EXPR_PROBABILIDAD`).

## Pruebas
- `stats.period.test.js`: bordes de mes en Lima (04:00Z del 1 de octubre sigue siendo septiembre), UTC, mes anterior, cambio de año, personalizado (días incluidos, periodo anterior) y todos los errores 400.
- `stats.service.test.js` (Mongo real): negocio sin datos, sin pipeline (no crea ninguno), 404, bordes de mes en Lima, mes anterior, personalizado, comparación con el periodo anterior, monedas mezcladas, monto 0, pendientes, ganados sin monto, más de 20 leads, fórmula y redondeo, temperatura como respaldo, listos para cerrar, top 5, pipeline propio con varias etapas, lead sin pipeline o con uno inactivo, zona sin configurar o inválida y aislamiento entre negocios.
- `stats.routes.test.js` (app real): permisos por rol (owner, admin, manager y viewer 200; sales, support y rol desconocido 403), el negocio sale del token (un `businessId` en la query no lo cambia), validación de la query y forma de la respuesta.
- `timezone.test.js`, `timezoneByCountry.test.js`: Lima, México, horario de verano, desbordes, tabla de países y default del modelo.
- **Control negativo:** se rompió a propósito el servicio de seis maneras (ignorar la zona, contar monto 0, `'won'` fijo, tope de 20, no filtrar por negocio, ignorar el estado) y cada una hace fallar al menos una prueba.

## Límites y riesgos
- Mientras la rama 2 (relleno de ventas ya cerradas) no se haya ejecutado, «Vendido» solo incluye ventas cerradas desde el despliegue de la rama 1, y los Ganado antiguos con monto aparecerán en `ganadosSinVenta`.
- `mission.service.js` conserva su propio respaldo `America/Mexico_City` cuando no hay zona; no se tocó.
- `getConversionsReport` ([reports.service.js](../../../src/modules/admin/reports.service.js)) sigue leyendo de `leads` con `'won'` fijo: dos fuentes hasta que se alinee en una rama posterior.
- `$lookup` con `localField/foreignField` + `pipeline` exige MongoDB ≥ 5.0 (local 7.0, Atlas 8.0).
- Sin migraciones ni variables nuevas.
