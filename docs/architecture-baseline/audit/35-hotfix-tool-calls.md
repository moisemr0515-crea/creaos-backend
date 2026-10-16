# 35 — HOTFIX P0: la IA deja de responder para siempre tras enviar media (`tool_calls` huérfanos)

Rama `hotfix/agente-tool-calls-huerfanos` (desde `main` `b570131`) y cherry-pick a `fase3/rag-media-fixes`. Solo local: sin push, sin deploy, sin merge a `main`, sin producción, sin secretos. Regla universal: nada depende de un teléfono, lead o negocio (tests con dos negocios).

| Rama | Commits |
|---|---|
| `hotfix/agente-tool-calls-huerfanos` | `c61c70d` (causa principal: orden + saneador + log seguro) · `efe26a6` (resultados largos) |
| `fase3/rag-media-fixes` | `618baf5` y `1d1e0af` (cherry-pick de los dos anteriores, sin conflictos) · `2264657` (test de que P2 no afecta al modelo, §3) |

## 1. Causa raíz (reproducida con un mock estricto de OpenAI)

Error de producción: `400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`.

1. **Dónde se persiste.** `ai.service.js#generateReply` (bucle de herramientas) hace, por vuelta: `messages.push(assistant con toolCalls)` → ejecuta cada herramienta → `messages.push(role:'tool', toolCallId)`. Todo se guarda de una vez al final (`persistGeneratedTurn`, `$push`).
2. **El defecto.** Mientras corren, `send_media` / `send_product_photos` (`ai/tools/index.js`, `persistAndEnqueueAiMedia`, el adjunto «[Video]») y `escalate_to_human` (nota de sistema) **agregan su propio mensaje a `conversation.messages`**. Resultado guardado: `[assistant(tool_calls), adjunto «[Video]», tool(resultado), …]`. OpenAI exige el resultado **inmediatamente** después de la llamada. Con varias llamadas en un mismo assistant el desorden es mayor.
3. **Dónde se reconstruye.** `construirVentanaDeMensajes(messages, 10)` arma los últimos 10 mensajes para cada turno nuevo. Ya descartaba resultados sin llamada, pero **no** comprobaba el orden ni las llamadas sin resultado. Mientras la llamada siga entre los últimos 10 mensajes, cada mensaje nuevo del lead produce el 400 ⇒ **la conversación queda envenenada** (los mensajes del lead sí se guardan, la IA no contesta).
4. **Sobre «el resultado se guarda como mensaje del contacto».** No existe en el código ninguna ruta que guarde el resultado con rol `user`: se guarda `role:'tool'` + `toolCallId` + `name` (ahora cubierto por test). Lo que ve el usuario como burbuja del contacto con JSON y burbuja vacía de la IA es **cómo el frontend pinta** `role:'tool'` y el assistant sin texto (audit/27 B.5); eso lo oculta P2, que **solo existe en `fase3/rag-media-fixes`**, no en `main`.

## 2. Cambios

1. **Persistencia (`generateReply`)**: tras ejecutar las herramientas de una vuelta, el tramo se reordena: primero los `tool` (con su rol y `tool_call_id`), después los efectos propios de las herramientas (adjunto, nota de sistema). El orden en tiempo real durante la ejecución no cambia (el anti-repetición de adjuntos sigue viéndolos).
2. **Saneador único en `construirVentanaDeMensajes`** (único punto que arma el historial del modelo; también se exporta para tests): cada resultado se emite **pegado a su llamada** aunque en la base esté más abajo; la llamada sin resultado se **elimina** (si traía texto, queda como mensaje normal del assistant); el resultado sin llamada en la ventana se **descarta**; `toolCalls: []` ya no genera un `tool_calls` vacío (otro 400). **Cura las conversaciones ya envenenadas sin migrar datos**: en cuanto el lead escribe de nuevo, el historial se sanea al vuelo.
3. **Log seguro (`runAgent`)**: cuando `generateReply` falla se registra un log estructurado con `correlationId`, `tenantId`, `conversationId`, `leadId`, `errorName`, `status`, `code`, `type` y un `detail` truncado a 200 caracteres con las secuencias largas de dígitos tapadas (`[num]`). Ya no se vuelca el mensaje crudo del error (podía citar texto o teléfonos). El `errorCode` que viaja al worker/InboundEvent/dead letter usa ese mismo `detail`.
4. **Segundo fallo silencioso hallado en la misma ruta** (`efe26a6`): `Conversation.messages.content` tiene `maxlength: 4000` y `persistGeneratedTurn` usa `runValidators`. Un resultado de herramienta de más de 4000 caracteres (por ejemplo `search_business_knowledge` con 5 fragmentos del PDF, o 5 productos con descripción larga) hacía lanzar `ValidationError` al guardar ⇒ **se perdía el turno completo** (respuesta incluida) y los reintentos fallaban igual. Ahora el contenido guardado se recorta con la marca `…[recortado]`; el modelo ve el resultado completo durante el turno. Reproducido primero (6413 caracteres ⇒ `ValidationError`).

## 3. Punto 2 — `esMensajeInterno` (P2) NO se aplica al historial del modelo
Verificado en `fase3/rag-media-fixes`: `esMensajeInterno` se usa únicamente en el `toJSON` del esquema `Conversation` (serialización de la API). `construirVentanaDeMensajes` lee `conversation.messages` directamente (documentos Mongoose, sin `toJSON`) y `persistGeneratedTurn` usa `toObject`. Test nuevo (`conversation.model.internalMessages.test.js`): `JSON.stringify(conv)` oculta las herramientas; el historial que recibe OpenAI conserva `tool_calls` y `tool` en orden. Además el test de punta a punta (§4) comprueba lo que viaja realmente al modelo en el turno siguiente.

## 4. Tests (`ai.service.generateReply.toolCallsHuerfanos.test.js`, 30 casos en total; los de punta a punta corren con 2 negocios)
Mock estricto de OpenAI que replica su validación (llamada sin resultados inmediatos, resultado sin llamada, `tool_calls` vacío) y se autocomprueba. Cubre lo pedido:
- **Tras enviar el video, el siguiente mensaje del lead obtiene respuesta** (y el tercero también); orden persistido `assistant(tool_calls)` → `tool` → adjunto; el historial al modelo conserva llamada y resultado.
- Varias llamadas en un assistant, con adjunto; `escalate_to_human` con su nota de sistema.
- Conversaciones ya envenenadas, cada una con respuesta: resultado separado por el adjunto (caso real), **resultado perdido**, **resultado guardado como mensaje del contacto**, **resultado huérfano**.
- Saneador puro: 8 casos (correcto sin cambios, separado por adjunto, llamada sin resultado con/sin texto, mensaje de contacto, huérfano, resultados parciales, `toolCalls: []`, corte de ventana).
- Resultado de más de 4000 caracteres (§2.4).
- Log sin teléfono ni texto del contacto y mensaje del contacto conservado tras el fallo.
**Control negativo:** sin el cambio en `ai.service.js` los tests de punta a punta fallan (se comprobó con `git stash`) y el de 4000 caracteres falla con el `ValidationError` real.

Suites completas (`--maxWorkers=2`): hotfix sobre `main`: 189 suites / 1814 tests verdes; `fase3/rag-media-fixes`: 214 suites / 2450 tests verdes. `git diff --check` limpio.

## 5. Cuando `generateReply` falla: ¿se pierde el mensaje? Dead letter y reproceso
**El mensaje del contacto no se pierde**: se guarda en la conversación (`saveInboundMessage` / `ensureLeadAndConversation`) **antes** de llamar al agente, y el texto también queda en el `InboundEvent`. Lo que no ocurre es la respuesta.

Hay dos caminos según `WHATSAPP_QUEUE_PROCESSING_ENABLED` (no puedo saber el valor en producción):
- **Modo cola (`true`)**: `runAgent` normaliza el fallo a `outcome:'error'`, `DefaultAgentRuntime` lo relanza y BullMQ reintenta el job **3 veces** (backoff 2 s, 4 s, 8 s; `removeOnFail:false`). Al agotarlos: (a) se añade un job a la cola `whatsapp-dead-letter` con `{ sourceQueue, jobData:{inboundEventId}, error, failedAt }`; (b) el `InboundEvent` queda `status:'failed'` con `error`; (c) el job fallido se conserva en Redis. **Nada se reprocesa solo.**
- **Modo síncrono (`false`)**: el fallo se propaga hasta el webhook (HTTP 500 a Gupshup, que puede reenviar). No hay cola ni dead letter; el mensaje ya está en el historial.

**Cómo reprocesar (tras desplegar el arreglo, con tu autorización):**
1. Listar (solo lectura, Atlas) `inboundevents` con filtro `{ "status": "failed" }`, ordenando por `createdAt` descendente: cada uno trae `tenantId`, `from` y `error`. Comparar con la ventana de 24 h de WhatsApp (`conversations.lastInboundMessageAt`): fuera de ella la IA no puede contestar con texto libre.
2. Reencolar cada uno con `enqueueInbound(<inboundEventId>)` (`channels/queues/inbound.queue.js`): si el job está en `failed` hace `retry()`, y si no existe lo crea. También se reencola solo si Gupshup reenvía el mismo `providerMessageId` y el evento está `received`/`failed`. El worker comprueba si ya existe una respuesta para ese evento (no la duplica) y `saveInboundMessage` descarta un `providerMessageId` ya guardado; no probé un reproceso real.
3. **No existe hoy un script ni endpoint para esto** (la DLQ lo documenta como pendiente). Puedo escribir `scripts/requeue-failed-inbound.js` con *dry-run* por defecto y filtro de ventana de 24 h si lo autorizas.
4. Los mensajes antiguos fuera de ventana no conviene reencolarlos: la conversación ya se cura sola cuando el lead escribe de nuevo y esa respuesta verá todo el historial.

## 6. Qué NO pude verificar sin producción
1. Que el 400 de producción tenga exactamente esta forma de historial: lo reproduje con un mock que replica las reglas documentadas de OpenAI, no contra la API real. Dato exacto: en Atlas, `conversations` de una conversación afectada, últimos ~12 elementos de `messages` (solo `role`, `toolCallId`, `toolCalls[].id` y `mediaType`; **sin `content`**), para confirmar `assistant(tool_calls)` → adjunto → `tool`.
2. Cuántas conversaciones están hoy envenenadas (el saneador las cura al escribir el lead, no hace falta contarlas) y cuántos `inboundevents` hay en `failed` (§5 paso 1).
3. Si producción corre en modo cola o síncrono (§5).
4. Que la ventana de 10 mensajes y el límite de 4000 caracteres sean los únicos topes que actúan (`RECENT_MESSAGES_LIMIT`, `maxlength`).
5. El hotfix **no** incluye P2: en `main` el frontend seguirá pintando la burbuja vacía y el JSON mientras no se despliegue `fase3/rag-media-fixes`.
6. Nada se ha desplegado ni fusionado: la rama `hotfix/agente-tool-calls-huerfanos` está lista para revisión.
