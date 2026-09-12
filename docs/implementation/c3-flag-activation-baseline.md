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
colgado). Un `completed` de `whatsapp-inbound` que sube de 1 a N con `failed:0`
es la señal esperada de que el mensaje real de WhatsApp se procesó bien.

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
