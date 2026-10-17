# 44 — Probabilidad de cierre por etapa en todo lead nuevo

Rama local `feat/probabilidad-por-etapa`, desde `main` = `8de993c`. Solo backend. No toca la IA. No está en producción.

## Qué hace
Todo lead **nuevo** nace con la probabilidad de cierre de **su etapa**, sin importar el camino por el que se creó. Antes solo `crearLead` (creación manual) la copiaba de la etapa; WhatsApp, Meta/TikTok y las automatizaciones nacían en 0 %, y como el «valor esperado» es valor × probabilidad, quedaba en 0 aunque el lead tuviera valor.

Un único gancho en `src/modules/leads/lead.model.js` (`pre('validate')`), en vez de repetirlo en cada creador:
- **Pipeline:** el del lead, si es de ESTE negocio y está activo; si no, el pipeline por defecto del negocio; si el negocio no tiene ninguno, las etapas por defecto (sin crearlo: es una lectura). Respeta las etapas y porcentajes propios de cada negocio.
- **Probabilidad explícita:** se respeta (incluido 0). Solo actúa si `closeProbability` sigue en su valor por defecto.
- **Solo leads nuevos** (`isNew`): guardar de nuevo un lead existente nunca la toca, y no hay ningún relleno escondido de leads antiguos.
- **Etapa que no existe en el pipeline**, o cualquier fallo al leer: queda como estaba (0 %). Nunca bloquea la creación de un lead (un WhatsApp entrante no se puede perder por esto).
- Solo toca `closeProbability`: no asigna `pipeline` ni cambia la etapa.
- Es `pre('validate')` y no `pre('save')` para que también corra con `insertMany()` (importación), que no ejecuta `pre('save')`.

Con el pipeline por defecto: new 5 % · contacted 20 % · negotiating 60 % · won 100 % · lost 0 %. Un lead de WhatsApp nace en «new», o sea 5 %.

## Archivos
- `src/modules/leads/lead.model.js` (el gancho; importa `pipeline.model`).
- `src/modules/leads/lead.model.probabilidadPorEtapa.test.js` (nuevo, 26 pruebas).

## Pruebas
- **Cada camino con su función real:** `crearLead`, WhatsApp por worker (`ensureLeadAndConversation`), Gupshup (`processGupshupMessage`), Meta Cloud API (`processWhatsAppMessage`), automatización `create_lead`, e importación con `insertMany`.
- **Pipeline propio:** el del lead, el por defecto cuando no hay pipeline en el lead, dos negocios con porcentajes distintos para la misma etapa, un pipeline de otro negocio (nunca se usa), uno inactivo (se ignora) y una etapa que no existe (queda en 0).
- **Probabilidad explícita** (0, 37, 100; también con `insertMany`) respetada.
- **Lead existente** no cambia al guardarse de nuevo (ni al cambiarle la etapa, ni uno antiguo con 0 %, ni uno sin el campo).
- **Bordes:** negocio sin pipeline usa las etapas por defecto y no crea ninguno; el gancho no asigna pipeline; fallo al leer el pipeline no pierde el lead.
- **Control negativo:** sin el gancho fallan 15 de las pruebas.
- Suite completa del backend (`--maxWorkers=2`): 212 suites y 2210 pruebas en verde. `git diff --check` limpio.

## HALLAZGO PREVIO, ajeno a este cambio (no se tocó)
`processMetaLead()` y `processTikTokLead()` ([webhook.service.js:158 y :255](../../../src/modules/webhooks/webhook.service.js)) lanzan **`ReferenceError: business is not defined`**: usan `business._id` en `assertActiveUserInBusiness(config.defaults?.assignedTo, business._id)` y esa variable no existe en esas funciones. Hay que usar `config.business`. **Mientras no se arregle, ningún lead de Meta Ads ni de TikTok se crea.** Entró con el commit `2cd5075` (14/sep/2026, «harden multi-tenant delivery…»).
Por eso las pruebas de Meta/TikTok comprueban la forma de creación del lead (los mismos campos), y un `test.failing` deja documentado el defecto: cuando se arregle, ese test empezará a fallar y habrá que convertirlo en una prueba normal.

## Límites y riesgos
- Un lead de WhatsApp en un pipeline propio cuya primera etapa no se llama «new» sigue naciendo con la etapa «new» (que no existe ahí) y por tanto con 0 %: es el comportamiento previo de esos creadores, no de este gancho.
- Una consulta de pipeline por lead nuevo (en importaciones masivas son N consultas; `shortcut` anotado en el código si hiciera falta cachear).
- Efecto visible al desplegar: los leads de WhatsApp pasan de 0 % a 5 % (y los de otras etapas a la suya), así que el «valor esperado» y los promedios del Pipeline suben en los leads nuevos. Los existentes no cambian.
- Sin migraciones ni variables nuevas.
