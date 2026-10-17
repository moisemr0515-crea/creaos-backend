# 42 — Registro único de ventas (rama 1: modelo + cerrarVenta)

Rama local `feat/registro-ventas`, desde `main` = `e473ad7`. Solo backend. **No toca la IA, ni el frontend, ni Estadísticas.** No está en producción.

## Qué hace
- Colección nueva `sales`: el registro único de «Vendido». Estadísticas leerá solo de aquí (rama 3); la v5.0 (medio de pago dentro de CREA OS) escribirá en la misma.
- `cerrarVenta` crea una venta al cerrar. El lead sigue guardando `actualValue` y `saleClosedAt`, así que nada existente se rompe.
- Un lead que **ya estaba Ganado** puede registrar su monto sin perder su fecha de cierre.

## Modelo `Sale` (`src/modules/sales/sale.model.js`)
| Campo | Detalle |
|---|---|
| `business` | obligatorio; siempre del token |
| `lead` | obligatorio; se valida contra ese negocio (otro negocio → 404) |
| `amount` | número ≥ 0 (un 0 se guarda; no cuenta como «Vendido», lo decide Estadísticas) |
| `currency` | copia de `Business.currency` al registrar; sin moneda válida queda `null` |
| `origin` | `manual` · `ai_proposal` · `receipt` · `crea_pay` |
| `status` | `pending` (por confirmar) · `confirmed` |
| `closedAt` | obligatoria si está confirmada; vacía si está por confirmar |
| `createdAt` | automática (no hay `updatedAt`) |
| `ref` | opcional; identificador externo (id de pago, nº de operación) |

Índices: `{business, status, closedAt:-1}`, `{business, lead}` y único parcial `{business, ref}` (solo cuando hay `ref`: un reintento de webhook no duplica la venta; el mismo `ref` en otro negocio sí vale).

`crearVenta(businessId, datos, { session })` (`sale.service.js`): `businessId` va primero y la moneda sale del negocio. Un `ref` repetido en el mismo negocio da 409.

## `cerrarVenta` (`src/modules/leads/lead.service.js`)
1. Justo después del `findOneAndUpdate` que garantiza la idempotencia (`saleClosedAt: null`) y **en la misma transacción**, se crea la venta `manual` / `confirmed` con la fecha del cierre. Cerrar dos veces, o dos a la vez, deja una sola venta.
2. El lead conserva `actualValue`, `saleClosedAt`, etapa, probabilidad, fechas e historial exactamente como antes.
3. **Si falla la venta, el lead no queda cerrado.** Con transacción (Atlas) Mongo revierte todo solo. Sin transacción (Mongo standalone de desarrollo y pruebas) se deshace a mano: se restauran los campos del lead, se quita la actividad del cierre y se borra la venta ya creada. Esto cubre también un stock insuficiente (409), que antes dejaba el lead cerrado en ese modo.
4. **Lead que ya está en una etapa ganada de su pipeline** (cerrado por la IA o arrastrando la tarjeta): solo se registra el monto.
   - No se toca `stageChangedAt` ni la etapa (queda en SU etapa ganada, aunque el pipeline tenga varias).
   - La venta nace con `closedAt` = el cierre original (`stageChangedAt`; si falta, `updatedAt`).
   - El historial anota «Monto registrado por …» y no se mueve `lastContactedAt`.
   - **No descuenta stock:** si llegan `items` responde 400.

## Pruebas
- Los 9 tests de `lead.service.cerrarVenta.test.js` pasan sin cambios.
- `src/modules/sales/sale.test.js` (nuevo): esquema, enums, obligatorios, monto 0 y negativo, confirmada/por confirmar, moneda, índices, `ref` duplicado (409, otro negocio sí, sin `ref` no choca), aislamiento entre negocios y lead de otro negocio (404).
- `src/modules/leads/lead.service.cerrarVenta.ventas.test.js` (nuevo): una sola venta, moneda y fecha, campos del lead intactos, idempotencia (incluida bajo carrera), monto 0, aislamiento, reversión si falla la venta o el stock, ya-Ganado conserva fecha / usa `updatedAt` / no descuenta stock / es idempotente / pipeline con varias etapas ganadas.
- **Control negativo:** con el `lead.service.js` anterior fallan 14 de las pruebas nuevas.

## Límites
- La reversión **transaccional** real es de MongoDB en Atlas; en local solo se puede probar el modo sin transacción (igual que el resto de la suite de `cerrarVenta`).
- Todavía no hay lectura de `sales` (Estadísticas es la rama 3) ni relleno de ventas antiguas (rama 2): hasta entonces las ventas se acumulan solas desde el despliegue en adelante.
- El `PUT /leads/:id` genérico aún permite escribir `actualValue` sin pasar por `cerrarVenta`; ese camino no crea venta (flujo viejo, fuera de alcance).
- Sin migraciones, sin variables nuevas.
