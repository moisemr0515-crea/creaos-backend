# Activación de `WHATSAPP_QUEUE_PROCESSING_ENABLED` en producción — baseline y rollback

**Fecha de activación:** 2026-09-12
**Servicio Railway modificado:** `creaos-backend` (API — es quien lee el flag en
[`inbound.gateway.js:7,17-20`](../../src/modules/channels/inbound.gateway.js) y decide
si procesa el mensaje entrante síncrono o lo encola). `creaos-backend-worker` no
necesita el flag — ya corre siempre los Workers de BullMQ, consuman o no.

Contexto completo: [C.3 — Architecture & Agent Runtime V1](c3-runtime-current-state.md),
etapas C3.1-C3.6, todas mergeadas a `main` antes de esta activación.

## Baseline de `/health` del worker — ANTES de activar el flag

Capturado vía script read-only equivalente al endpoint `GET /health` de
[`worker.js:56-77`](../../worker.js), contra el mismo `REDIS_URL` de producción
(sin exponer el worker públicamente ni usar SSH), más `railway logs --service
creaos-backend-worker` confirmando boot limpio (Redis/Mongo conectados, sin
errores).

```json
{
  "status": "ok",
  "queues": {
    "whatsapp-inbound":   { "active": 0, "completed": 1,   "failed": 0, "waiting": 0, "delayed": 0 },
    "whatsapp-outbound":  { "active": 0, "completed": 4,   "failed": 0, "waiting": 0, "delayed": 0 },
    "automation-sweep":   { "active": 0, "completed": 137, "failed": 0, "waiting": 0, "delayed": 1 },
    "automation-execute": { "active": 0, "completed": 0,   "failed": 0, "waiting": 0, "delayed": 0 }
  }
}
```

**Cómo usar este baseline:** en la primera hora después de activar, volver a
consultar `/health` (mismo método) y comparar. Señales de alarma reales:
`failed > 0` en `whatsapp-inbound`/`whatsapp-outbound`, `waiting` creciendo sin
bajar (el Worker no está consumiendo), o `active` que no vuelve a 0 (job
colgado).

**Corrección importante sobre `completed` (no usarlo como señal — ver
investigación abajo):** el número de `completed` de `/health` **no es un
contador histórico acumulado**, así que no sirve para comparar "¿subió o
bajó?" contra este baseline. Es la cantidad de jobs actualmente retenidos bajo
la política de 7 días (`removeOnComplete`, ver más abajo) — puede bajar sin
que eso signifique ningún problema. Las únicas señales confiables son
`failed`, `waiting` y `active`.

## Resultado real de la primera prueba (mensaje real de WhatsApp, 2026-09-12 15:39 UTC)

El usuario mandó un mensaje real ("Hola") después de activar el flag.
Verificado de forma independiente en 3 fuentes (no solo el log del propio
proceso):

- **Mongo, `InboundEvent`:** `status:"processed"`, `createdAt` → `processedAt`
  en ~6s, sin `error`.
- **Mongo, `OutboundEvent`:** `status:"sent"`, `sourceInboundEvent` apuntando
  al InboundEvent de arriba, con el texto real de la respuesta generada.
- **Logs de `creaos-backend-worker`** (no de la API — confirma que corrió por
  el camino nuevo): trace `AGENT_RUN` de C3.4 seguido del envío real por
  Gupshup Partner API, ~2.5s de duración de `runAgent()`.

`/health` inmediatamente después: `failed:0`, `waiting:0`, `active:0` en las 4
colas — sano.

### Investigación: por qué bajó el `completed` (whatsapp-outbound 4→1, whatsapp-inbound 1→1 en vez de 1→2)

Causa confirmada inspeccionando directamente el ZSET de BullMQ en Redis
(`bull:whatsapp-outbound:completed` / `bull:whatsapp-inbound:completed`, vía
`ZRANGE ... WITHSCORES`): después del mensaje de prueba, cada cola tenía
**un solo job** en su set de completados (`jobId=5` en outbound, `jobId=2` en
inbound), con timestamp exacto del mensaje de hoy. Los `jobId` confirman que
antes existieron más (4 y 1 respectivamente) — no es que nunca hubo nada, es
que ya no están.

Explicación: [`src/config/queue.js:55`](../../src/config/queue.js)
configura `removeOnComplete: { age: 60 * 60 * 24 * 7 }` (7 días) para ambas
colas. BullMQ no limpia con un barrido en segundo plano — el trim por
antigüedad se aplica de forma perezosa, recién cuando un job NUEVO completa.
Los 4 jobs viejos de `whatsapp-outbound` databan del 15 de agosto (~28 días,
muy por encima de los 7) y quedaron visibles en `getJobCounts()` sin
limpiarse simplemente porque, con el flag apagado, no había entrado ningún
job nuevo que disparara la limpieza. El mensaje de hoy fue el primer job real
desde la activación, disparó el trim pendiente, y los viejos desaparecieron
del contador — dejando solo el de hoy.

**No es pérdida de datos:** `removeOnComplete` borra solo el bookkeeping
interno de BullMQ en Redis — nunca tocó `InboundEvent`/`OutboundEvent` en
Mongo, que son el registro real y fuente de verdad (el `OutboundEvent` del 15
de agosto se pudo leer completo desde Mongo sin problema). Es la misma
política de retención que ya regía antes de C.3; la activación del flag solo
fue lo que disparó una limpieza que estaba pendiente hace tiempo.

## Plan de rollback (verificado antes de activar, no solo prometido)

- **Acción de rollback:** volver `WHATSAPP_QUEUE_PROCESSING_ENABLED` a `false`
  en el servicio `creaos-backend` (Railway) y redeploy. Un solo valor, un solo
  servicio.
- **¿Pérdida de mensajes en tránsito?** No. El flag solo decide, en
  `inbound.gateway.js`, si un mensaje ENTRANTE nuevo se procesa síncrono o se
  encola — no interrumpe nada a mitad de camino. Un mensaje ya encolado en
  BullMQ antes del rollback lo sigue procesando el Worker igual (el Worker no
  depende del flag, corre siempre) hasta vaciar la cola; un mensaje que llegue
  DESPUÉS del rollback vuelve al camino síncrono de siempre.
- **¿Y si el Worker mismo falla?** BullMQ reintenta 3 veces con backoff
  exponencial (`DEFAULT_JOB_OPTIONS`, `src/config/queue.js`) y manda a
  `whatsapp-dead-letter` si agota los intentos — visible en Mongo
  (`InboundEvent.status:'failed'`) y en la dead letter queue, no se pierde en
  silencio.
- **Verificado en este chequeo:** worker Online, 0 failed/waiting en las 4
  colas antes de activar (ver baseline arriba).
