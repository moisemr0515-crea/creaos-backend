# 45 — Leads de Meta Ads y TikTok: no se creaban

Rama local `fix/leads-meta-tiktok`, desde `main` = `8de993c`. Solo backend. No está en producción.

## El defecto
`processMetaLead()` y `processTikTokLead()` ([webhook.service.js:158 y :255](../../../src/modules/webhooks/webhook.service.js)) validaban al agente asignado con `assertActiveUserInBusiness(config.defaults?.assignedTo, business._id)`, pero la variable `business` **no existe** en esas funciones. Lanzaban `ReferenceError: business is not defined` justo antes de `Lead.create()`: **ningún lead de Meta Ads (formularios) ni de TikTok se ha creado desde entonces.**

**Arreglo en la raíz:** el negocio es el de la configuración del webhook, `config.business` (el mismo con el que se crea el lead). El agente asignado se sigue validando contra ESE negocio.

**Por qué nadie lo vio:**
- El controlador responde 200 **antes** de procesar ([webhook.controller.js:42-60](../../../src/modules/webhooks/webhook.controller.js)), así que Meta y TikTok creen que llegó bien y **no reintentan**.
- El error solo se registra con `console.error('[webhook] Meta processLead error:', err.message)`: un texto sin el id del lead.
- No existía ninguna prueba de estas dos funciones, y el backend no tiene linter (`no-undef` lo habría detectado).

## Desde cuándo
- El commit `2cd5075` («harden multi-tenant delivery…», 14/sep/2026 16:30, hora de Lima) introdujo `business._id`. Llegó a `origin/main` en un push registrado el **14/sep/2026 a las 16:30:46 (-05)**; el push anterior, del 13/sep 21:10, no lo tenía.
- Railway despliega `main` automáticamente, así que **desde ~14/sep/2026 16:30 (hora de Lima)** hasta hoy (**unos 33 días**). Esto solo importa si el negocio tiene activa una configuración de Meta o TikTok.

## Qué datos tenemos para recuperarlos (sin escribir en producción)
**Lo que NO guardamos:** el cuerpo del webhook (se descarta tras el 200) ni el `leadgen_id`/`lead_id`; el lead de Meta se descarga con la API y se pierde al fallar. `Lead.adSource` solo tiene `platform`, `campaignId`, `adSetId`, `adId` y `formId` (el `leadgenId` ni siquiera está en el esquema). Es decir, **no se puede reconstruir un lead perdido a partir de nuestra base.**

**Lo que sí sirve para medir el daño** (consultas de solo lectura en Atlas):
1. Última vez que cada configuración recibió un lead de verdad: `lastReceivedAt` y `totalLeadsReceived` solo se actualizan al crear un lead con éxito, así que se quedaron congelados:
   ```js
   db.webhookconfigs.find({ platform: { $in: ["meta", "tiktok"] }, isActive: true },
     { business: 1, platform: 1, pageId: 1, adAccountId: 1, formIds: 1, lastReceivedAt: 1, totalLeadsReceived: 1 })
   ```
2. Último lead de anuncios que sí entró, por negocio y plataforma:
   ```js
   db.leads.aggregate([
     { $match: { "adSource.platform": { $in: ["meta", "tiktok"] } } },
     { $group: { _id: { business: "$business", plataforma: "$adSource.platform" }, ultimo: { $max: "$createdAt" }, total: { $sum: 1 } } }
   ])
   ```
3. Registros de Railway (API): buscar el texto exacto `[webhook] Meta processLead error: business is not defined` y `[webhook] TikTok processLead error: business is not defined`. Dan **cuántas veces** y **cuándo**, no **quiénes**. Su retención depende del plan de Railway.

**Dónde están los leads perdidos de verdad: en Meta y TikTok.**
- **Meta:** los leads de formularios siguen en Meta (Meta Business Suite → Leads Center, con descarga CSV, o la API `GET /{form_id}/leads`). La configuración guarda el token cifrado (`accessTokenEncrypted`) y los `formIds`, así que se puede escribir un script de recuperación. El plazo en que Meta conserva los leads hay que confirmarlo en su panel: **conviene exportar YA**.
- **TikTok:** exportación de leads desde TikTok Ads Manager (o su API de Lead Generation). Mismo consejo: exportar ya y confirmar el plazo.
- Un script de recuperación (no hecho; haría falta tu autorización y escribe en producción): lista los leads desde el día del defecto, deduplica por correo y teléfono y los crea con la función ya corregida. **No se debe reenviar mensajes a esos leads automáticamente.**

## Pruebas
`webhook.service.metaTiktok.test.js` (nuevo, 15 pruebas, Mongo real; solo se simula la llamada HTTP a Meta y el token):
- **Meta:**
  - Lead con los datos del formulario, en el negocio de la configuración.
  - Su conversación y los contadores de la configuración.
  - Valores por defecto (etapa, temperatura, fuente, etiquetas, agente).
  - Agente de otro negocio rechazado.
  - Varios leads en una notificación.
  - Duplicado por correo.
  - Sin datos.
  - Formularios fuera de lista.
  - Error de la API de Meta.
- **TikTok:** equivalentes, con lista de leads.
- **Control negativo:** sin el arreglo fallan 12 con `ReferenceError: business is not defined` (las 3 que pasan son las que no llegan a crear el lead).
- **Suite completa del backend** (`--maxWorkers=2`): resultado en el mensaje de entrega.

## Probabilidad por etapa (rama `feat/probabilidad-por-etapa`, aún sin fusionar)
Se verificó combinando temporalmente ambas ramas (rama temporal ya borrada, sin commit): con la función corregida, un lead de Meta o de TikTok nace con la probabilidad de **su etapa**: etapa por defecto «new» → 5 %, `defaults.pipelineStage: 'contacted'` → 20 %, `'negotiating'` → 60 % (6 de 6 comprobaciones en verde).

**Al fusionar las dos ramas hay que hacer un cambio de una vez** en `lead.model.probabilidadPorEtapa.test.js` (rama de probabilidad): el `test.failing` «Meta/TikTok — las funciones reales hoy fallan…» pasará a **fallar** porque el defecto ya no existe (confirmado en la combinación). Hay que borrar ese bloque y su comentario y, en su lugar, dejar pruebas normales con `processTikTokLead`/`processMetaLead` (configuración `{ _id, business, defaults: { pipelineStage } }`) que comprueben 5 / 20 / 60 %.

## Riesgos
1. **Datos ya perdidos:** los leads de ~33 días solo se recuperan desde Meta/TikTok y con plazo de conservación limitado; la prioridad es exportarlos.
2. **Recontacto tardío:** un lead de hace semanas ya está frío y no hay ventana de WhatsApp abierta; solo se puede contactar con plantilla. La conversación nueva nace con `aiEnabled: true` y canal `manual`: conviene revisar si se quiere que la IA responda a leads recuperados.
3. **Misma clase de fallo, otro disparador:** si el agente asignado en la configuración está inactivo o es de otro negocio, `assertActiveUserInBusiness` lanza 400 y **el lead se pierde igual, en silencio** (decisión de endurecimiento de `2cd5075`; no se cambió). Y un lead que lanza error corta el procesamiento de los siguientes de la misma notificación. Recomiendo que un agente inválido cree el lead sin asignar y avise, en una rama aparte.
4. **Sin visibilidad:** el controlador responde 200 antes de procesar y solo registra el texto del error. Recomiendo registrar `leadgen_id`/`lead_id` y el negocio al fallar, y/o guardar el cuerpo del webhook, para que un fallo futuro sea recuperable.
5. **Sin linter:** añadir ESLint con `no-undef` evitaría esta clase de error.
6. **Duplicados al recuperar:** el control de duplicados es solo por correo; un lead con teléfono y sin correo podría duplicarse si se reenvía.
