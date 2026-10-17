# 46 — Contadores de Estadísticas en el servidor

Rama local `feat/stats-contadores`, desde `main` = `a8b41db`. Solo backend. No toca la IA. No está en producción. Es **aditiva**: `GET /api/v1/stats/summary` conserva todo lo que ya devolvía y añade un bloque `contadores`.

## Qué devuelve
```json
"contadores": { "leads": 45, "calientes": 12, "cerrados": 10, "tasaDeCierre": 22, "cierrePromedioDias": 14.3 }
```
Se calculan en el servidor sobre **todos** los leads (antes la pantalla los calculaba con los 20 más recientes), con las etapas ganada/perdida del pipeline de cada lead (no un `'won'` fijo), solo con el negocio del token y con el mismo permiso que el resto (`reports:read`: Sales y Support reciben 403 y ningún contador).

## Las definiciones de los contadores (las de `stats.tsx`, salvo el cierre promedio, que cambió: ver abajo)
| Contador | Definición |
|---|---|
| **Leads** | Todos los leads activos del negocio: cuenta ganados y perdidos; **no** los borrados ni los archivados. |
| **Calientes** | Leads **abiertos** (ni ganados ni perdidos) con temperatura «caliente» **o** probabilidad de cierre ≥ 70 %. Es el mismo número que «Listos para cerrar» de En conversaciones. |
| **Cerrados** | Leads que están en una etapa **ganada** de su pipeline. |
| **Tasa de cierre** | Cerrados ÷ Leads, en porcentaje y **redondeada** (2 de 3 = 67 %). Los perdidos cuentan en el total. 0 si no hay leads. |
| **Cierre promedio** | **Definición aprobada:** promedio, de los leads **ganados**, de los días desde la creación del lead hasta su cierre. Fecha de cierre = la de su **primera venta confirmada** (`sales.closedAt`) si existe; si no, el **último cambio de etapa a ganado** (`stageChangedAt`). 24 horas = 1 día; un cierre anterior a la creación cuenta 0 (nunca negativo). Un ganado sin ninguna de las dos fechas cuenta como cerrado pero no entra al promedio. |

Dos precisiones sobre cómo quedaron:
- **Son de todo el historial, no del mes elegido.** Cambiar «Este mes» / «Mes anterior» no los mueve (hay una prueba que lo fija). Por eso la zona horaria del negocio no cambia ningún contador: ninguna de estas definiciones depende del día de calendario. Si quieres contadores **por periodo** (leads nuevos del mes, cerrados del mes…), es una decisión de producto aparte.
- `cierrePromedioDias` se devuelve **sin redondear** (o `null` si no hay ningún ganado con fecha de cierre), para que la pantalla decida cómo mostrarlo: un decimal («3,5 d»), «Menos de 1 d» si es menor que un día y «—» solo si es `null`.

## Cierre promedio: definición aprobada y aplicada
El «cierre promedio» que se mostraba (14 d) tenía una definición dudosa: salía de los 20 leads más recientes, la «fecha de cierre» era el último cambio de etapa (que se mueve si alguien marca «Ganado» días después de cobrar o el lead pasa de ganado a otra etapa y vuelve), se redondeaba a días enteros y un 0 se mostraba como «—». Se aprobó esta definición (sin mediana):

> **Días desde la creación del lead hasta su cierre.** Fecha de cierre = la de su **primera venta confirmada** en `sales` (`closedAt`) si existe; si no, el **último cambio de etapa a ganado**. Si la fecha de cierre queda antes de la creación, cuenta 0 (nunca negativo). Se muestra con un decimal («3,5 d»), «Menos de 1 d» si es menor que un día y «—» solo si no hay ningún ganado.

Cómo quedó:
- **Primera venta confirmada** = la de `closedAt` más antigua entre las ventas confirmadas del lead (una venta confirmada con monto 0 también cuenta; una por confirmar no). Solo ventas del propio negocio.
- **Se calcula sobre todos los ganados**, no sobre 20.
- **Un ganado sin ninguna de las dos fechas** (un lead muy antiguo, sin venta registrada y sin fecha de cambio de etapa) cuenta en «Cerrados» pero no entra al promedio: no se inventa una fecha. Si **todos** los ganados estuvieran en ese caso, el promedio sería `null` y se vería «—» aunque haya ganados; es el único caso en que «—» no significa «no hay ganados».
- **Mientras no se ejecute el relleno de ventas anteriores** (rama 2 del registro de ventas), los ganados antiguos no tienen venta en `sales` y usan el cambio de etapa. Al ejecutar el relleno su fecha pasa a ser la de su venta.
- Las cifras mostradas **cambiarán** respecto al 14 d de antes (otra muestra y otra fecha de cierre); es lo esperado.

## Archivos
- `src/modules/stats/stats.service.js` (el bloque `contadores`: dos consultas nuevas; no cambia nada de lo existente).
- `src/modules/stats/stats.contadores.test.js` (nuevo) y `stats.routes.test.js` (la forma de la respuesta y el permiso).

## Pruebas
- Negocio sin datos (ceros y `null`); más de 20 leads (45 leads: 30 abiertos, 10 ganados y 5 perdidos); definiciones (activos, calientes, tasa redondeada); cierre promedio (promedio, sin redondear, sin fecha, solo ganados, negativo a 0, `null`; con venta confirmada manda la venta y no el cambio de etapa, varias ventas → la primera, venta de monto 0, venta por confirmar ignorada, mezcla con y sin venta, venta sin cambio de etapa, venta anterior a la creación → 0, ventas de otro negocio ignoradas, venta de un lead abierto ignorada); pipeline propio (etapas isWon/isLost de cada lead, sin pipeline o con uno inactivo); periodo y zona (los contadores no cambian con el periodo, borde de mes de Lima, no dependen de la zona); aislamiento entre negocios; permisos (Sales y Support 403 sin `contadores`; Owner, Admin, Manager y Viewer 200 con ellos).
- **Control negativo:** 8 mutaciones del bloque original (tope de 20, contar archivados, `'won'` fijo, negativos sin limitar a 0, `0` en vez de `null`, tasa truncada, calientes distinto de «listos para cerrar», sin filtrar por negocio) y **7 más para la definición aprobada** (ignorar las ventas, usar la última venta en vez de la primera, contar ventas por confirmar, no filtrar las ventas por negocio, cierre negativo, `0` en vez de `null`, fecha inventada para un ganado sin fechas); cada una hace fallar al menos una prueba.
- Suite completa (`--maxWorkers=2`): resultado en el mensaje de entrega.

## Límites
- El `$lookup` a `sales` (por ganado) exige MongoDB 5.0 o superior, igual que el resto del endpoint.
- Sin migraciones ni variables nuevas.
