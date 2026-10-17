# 46 — Contadores de Estadísticas en el servidor

Rama local `feat/stats-contadores`, desde `main` = `a8b41db`. Solo backend. No toca la IA. No está en producción. Es **aditiva**: `GET /api/v1/stats/summary` conserva todo lo que ya devolvía y añade un bloque `contadores`.

## Qué devuelve
```json
"contadores": { "leads": 45, "calientes": 12, "cerrados": 10, "tasaDeCierre": 22, "cierrePromedioDias": 14.3 }
```
Se calculan en el servidor sobre **todos** los leads (antes la pantalla los calculaba con los 20 más recientes), con las etapas ganada/perdida del pipeline de cada lead (no un `'won'` fijo), solo con el negocio del token y con el mismo permiso que el resto (`reports:read`: Sales y Support reciben 403 y ningún contador).

## Las definiciones actuales de `stats.tsx` (se conservan tal cual)
| Contador | Definición |
|---|---|
| **Leads** | Todos los leads activos del negocio: cuenta ganados y perdidos; **no** los borrados ni los archivados. |
| **Calientes** | Leads **abiertos** (ni ganados ni perdidos) con temperatura «caliente» **o** probabilidad de cierre ≥ 70 %. Es el mismo número que «Listos para cerrar» de En conversaciones. |
| **Cerrados** | Leads que están en una etapa **ganada** de su pipeline. |
| **Tasa de cierre** | Cerrados ÷ Leads, en porcentaje y **redondeada** (2 de 3 = 67 %). Los perdidos cuentan en el total. 0 si no hay leads. |
| **Cierre promedio** | Promedio, de los leads ganados que tienen fecha de cierre, de los días entre su creación (`createdAt`) y su último cambio de etapa (`stageChangedAt`, el momento en que llegaron a «ganado»). 24 horas = 1 día; un resultado negativo cuenta como 0. Un ganado sin esa fecha cuenta como «cerrado» pero no entra al promedio. La pantalla redondeaba a días enteros y mostraba «—» si daba 0. |

Dos precisiones sobre cómo quedaron:
- **Son de todo el historial, no del mes elegido.** Cambiar «Este mes» / «Mes anterior» no los mueve (hay una prueba que lo fija). Por eso la zona horaria del negocio no cambia ningún contador: ninguna de estas definiciones depende del día de calendario. Si quieres contadores **por periodo** (leads nuevos del mes, cerrados del mes…), es una decisión de producto aparte.
- `cierrePromedioDias` se devuelve **sin redondear** (o `null` si no hay ningún ganado con fecha), para que la pantalla decida cómo mostrarlo. Redondeado a entero da lo mismo que daba antes.

## El «cierre promedio» de 14 d: ¿es fiable? (no se cambió; espero tu decisión)
La definición **es dudosa**, por estos motivos:
1. **Muestra pequeña y sesgada:** salía de los 20 leads más recientes; un negocio con más ventas antiguas (ciclos más largos) o más recientes (ciclos más cortos) quedaba mal representado. Ahora, sin ese tope, el número cambiará, y es esperable.
2. **La «fecha de cierre» no es la fecha real de la venta:** es el último cambio de etapa. Si alguien (o la IA) marcó «Ganado» días después de cobrar, o un lead pasó de ganado a otra etapa y volvió, la fecha se mueve. La venta confirmada (`sales.closedAt`) sí guarda la fecha real y la conserva.
3. **`createdAt` no siempre es el primer contacto:** en leads importados es la fecha de importación.
4. **El promedio aritmético se deja arrastrar por un caso extremo** (un lead de 90 días sube el resultado); la mediana es más fiel a «lo normal».
5. **Se redondeaba a días enteros y un 0 se mostraba como «—»:** un cierre promedio de menos de medio día parecía «sin datos».
6. **Los ganados sin fecha de cierre quedaban fuera en silencio.**

**Definición propuesta (no aplicada):** *cierre promedio = promedio de días desde la creación del lead hasta su cierre, para los leads ganados; fecha de cierre = la de su venta confirmada (`closedAt`) si la tiene y, si no, el último cambio de etapa a ganado.* Se mostraría con un decimal («3,5 d»), «Menos de 1 d» cuando sea menor que un día y «—» solo si no hay ningún ganado. Opcional: mostrar también la mediana. Para el histórico, las ventas anteriores a `sales` seguirían usando el cambio de etapa hasta que se ejecute el relleno de ventas.

## Archivos
- `src/modules/stats/stats.service.js` (el bloque `contadores`: dos consultas nuevas; no cambia nada de lo existente).
- `src/modules/stats/stats.contadores.test.js` (nuevo) y `stats.routes.test.js` (la forma de la respuesta y el permiso).

## Pruebas
- Negocio sin datos (ceros y `null`); más de 20 leads (45 leads: 30 abiertos, 10 ganados y 5 perdidos); definiciones (activos, calientes, tasa redondeada); cierre promedio (promedio, sin redondear, sin fecha, solo ganados, negativo a 0, `null`); pipeline propio (etapas isWon/isLost de cada lead, sin pipeline o con uno inactivo); periodo y zona (los contadores no cambian con el periodo, borde de mes de Lima, no dependen de la zona); aislamiento entre negocios; permisos (Sales y Support 403 sin `contadores`; Owner, Admin, Manager y Viewer 200 con ellos).
- **Control negativo:** 8 mutaciones del servicio (tope de 20, contar archivados, `'won'` fijo, negativos sin limitar a 0, `0` en vez de `null`, tasa truncada, calientes distinto de «listos para cerrar», sin filtrar por negocio) y cada una hace fallar al menos una prueba.
- Suite completa (`--maxWorkers=2`): resultado en el mensaje de entrega.

## Límites
- Si más adelante cambia la definición de «cierre promedio», cambiarán las cifras ya mostradas.
- Sin migraciones ni variables nuevas.
