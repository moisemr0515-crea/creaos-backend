# DOCUMENTO MAESTRO DE CONTINUIDAD TÉCNICA
## CREA OS — Diagnóstico profundo posterior al hardening realizado por Codex

**Proyecto:** CREA OS  
**Sistema principal:** Agente de ventas IA multi-tenant  
**Estado:** Prueba cerrada / validación previa a lanzamiento público  
**Fecha de referencia:** septiembre de 2026

## Workspace autorizado

```text
C:\PROYECTOS\CREA-OS
```

### Backend

```text
C:\PROYECTOS\CREA-OS\creaos-backend
```

### Frontend

```text
C:\PROYECTOS\CREA-OS\crea-os-ignite-main
```

### Regla de infraestructura

A partir de esta etapa CREA OS debe operar completamente desde `C:\`.

No deben introducirse dependencias activas de:

```text
E:\
```

Las referencias antiguas a `E:\` pueden existir únicamente como logs, cachés, documentación histórica o rastros no operativos.

---

## 1. OBJETIVO DE ESTE DOCUMENTO

CREA OS fue sometido a una auditoría integral mediante Codex.

La auditoría encontró problemas reales de:

- seguridad;
- aislamiento multi-tenant;
- autenticación;
- webhooks;
- WhatsApp;
- procesamiento asíncrono;
- pagos;
- entitlement;
- configuración de producción;
- Android;
- pruebas;
- deuda técnica.

Después se trabajó durante varios bloques para corregir esos problemas.

Los bloques quedaron consolidados:

```text
P0      ✅
P1-1    ✅
P1-2    ✅
P1-3    ✅
P2-A    ✅
P2-B    ✅
P3      ✅

ENTORNO 100% C:\ ✅
```

Sin embargo, después de ese endurecimiento aparecieron problemas funcionales en pruebas reales.

El objetivo NO es volver al código anterior.

El objetivo es:

> Encontrar qué contratos, estados, dependencias, middlewares, flujos o integraciones quedaron incompatibles después del hardening y corregirlos manteniendo las mejoras arquitectónicas y de seguridad.

---

## 2. PRINCIPIO FUNDAMENTAL

No utilizar la palabra ni el enfoque de “rollback” como solución inicial.

Tampoco asumir:

```text
Antes funcionaba → volvamos al código anterior.
```

Eso sería incorrecto.

La estrategia debe ser:

```text
arquitectura endurecida
        ↓
diagnóstico
        ↓
identificación de incompatibilidad
        ↓
adaptación del flujo
        ↓
pruebas
        ↓
arquitectura endurecida + funcionalidad restaurada
```

El resultado esperado es un CREA OS:

- más seguro;
- multi-tenant;
- consistente;
- tolerante a fallos;
- escalable;
- y funcional de extremo a extremo.

---

## 3. ESTADO QUE ENCONTRÓ CODEX EN LA AUDITORÍA ORIGINAL

Codex realizó inicialmente una auditoría de:

```text
Backend:
C:\PROYECTOS\CREA-OS\creaos-backend

Frontend:
C:\PROYECTOS\CREA-OS\crea-os-ignite-main
```

La conclusión inicial fue aproximadamente:

```text
NO LISTO — RIESGO CRÍTICO
```

No porque CREA OS no funcionara, sino porque existían varios puntos donde el sistema funcionaba operativamente pero no tenía todavía las garantías necesarias para escalar como plataforma multi-tenant.

---

## 4. P0 — AISLAMIENTO MULTI-TENANT ADMINISTRATIVO

### Problema encontrado

Existían endpoints administrativos que aceptaban algo como:

```text
businessId
```

desde parámetros de URL.

Ejemplos:

```text
/admin/dashboard/:businessId
/admin/activity/:businessId
```

La lógica podía utilizar directamente:

```text
req.params.businessId
```

sin comprobar suficientemente si el usuario pertenecía realmente a ese negocio.

### Riesgo

Un tenant podía potencialmente intentar consultar información de otro tenant modificando el identificador.

Eso constituía un problema tipo:

```text
IDOR
```

y era especialmente grave para CREA OS porque la arquitectura es multi-tenant.

---

## 5. SOLUCIÓN IMPLEMENTADA EN P0

Codex centralizó la resolución del negocio autorizado.

La autoridad dejó de ser únicamente:

```text
req.params.businessId
```

y pasó a apoyarse principalmente en:

```text
req.user.business
```

obtenido del usuario autenticado.

También podía utilizarse:

```text
req.businessId
```

como respaldo controlado.

Un usuario normal no podía consultar arbitrariamente otro negocio.

Solo una función administrativa autorizada podía trabajar con otro tenant.

### Resultado esperado

```text
Tenant A
→ solo Tenant A

Tenant B
→ solo Tenant B
```

sin lectura cruzada.

---

## 6. P0 — WEBHOOKS FAIL-OPEN

### Problema original

Algunas verificaciones de webhooks se comportaban estrictamente solo si:

```text
NODE_ENV === production
```

pero:

- `NODE_ENV` podía faltar;
- el fallback podía convertirse en development;
- algunas integraciones aceptaban eventos sin validación completa.

Esto afectaba integraciones como:

- Meta;
- WhatsApp;
- Gupshup;
- Stripe;
- Mercado Pago;
- TikTok.

---

## 7. SOLUCIÓN P0 DE WEBHOOKS

Se endureció la configuración.

`NODE_ENV` pasó a ser obligatorio.

La aplicación debía fallar al arrancar si una configuración obligatoria de producción faltaba.

Los secretos de webhook correspondientes pasaron a comprobarse según las integraciones habilitadas.

Se introdujo el principio:

```text
Fail Closed
```

en lugar de:

```text
Fail Open
```

Es decir:

> ante una configuración inválida, el sistema debe rechazar la operación antes que aceptar un evento potencialmente falso.

---

## 8. VALIDACIÓN DEL BLOQUE P0

Después de los cambios se llegaron a ejecutar suites como:

```text
24/24 pruebas P0
952/952 backend
```

y posteriormente la suite continuó creciendo a medida que se incorporaban más pruebas.

El bloque fue consolidado y enviado a `origin/main`.

---

## 9. P1-1 — PLANES, PAGOS Y ENTITLEMENT

La auditoría detectó un problema arquitectónico importante:

El frontend tenía demasiada autoridad sobre:

- plan actual;
- límites;
- capacidades;
- contadores;
- éxito de checkout.

Existía riesgo de que valores almacenados en:

```text
localStorage
```

o incluso parámetros de URL alteraran estados visuales o comerciales.

---

## 10. PROBLEMAS EN PLANES ANTES DE LA CORRECCIÓN

Se encontraron diferentes fuentes de verdad.

Por ejemplo, diferentes partes de la aplicación tenían límites distintos.

Había valores como:

```text
Starter:
5 / 10 / 20

Closer:
100 / 300

Dominator:
300 / 1000
```

dependiendo del archivo consultado.

También existían contradicciones en automatizaciones:

```text
20
100
400
```

según distintas partes del frontend/backend.

---

## 11. PLANES DEFINITIVOS CONSOLIDADOS

Se sincronizaron con el frontend comercial real de CREA OS.

### STARTER

```text
Precio: Gratis

Oportunidades activas: 20
Usuarios: 1
Automatizaciones: 0
IA: básica asistida
WhatsApp: integrado
CRM: sí
Pipeline: sí
Dashboard básico
Roles y permisos
```

### CLOSER

```text
US$29 / mes

Oportunidades: 300
Usuarios: 1
Automatizaciones: 100
IA automática 24/7
WhatsApp Business integrado
Seguimiento automático
Cierre asistido IA
Dashboard
Estadísticas
Roles/permisos
```

### DOMINATOR

```text
US$79 / mes

Oportunidades: 1000
Usuarios: 1
Automatizaciones: 400
IA avanzada
WhatsApp integrado
Seguimiento automático
Cierre asistido
Dashboard
Estadísticas
Reportes avanzados
```

---

## 12. FUENTE ÚNICA DE VERDAD

La autoridad definitiva pasó al backend.

Conceptualmente:

```text
Subscription
       +
Plan.limits
       ↓
getEntitlement()
```

El frontend dejó de decidir autónomamente las capacidades.

El navegador pasó a ser consumidor del estado del backend.

---

## 13. MERCADO PAGO

También se endureció el flujo.

Antes existía riesgo de:

```text
checkout
→ retorno
→ frontend supone éxito
→ plan concedido
```

El nuevo modelo pretende ser:

```text
checkout
↓
pending
↓
Mercado Pago
↓
webhook firmado
↓
validación del pago
↓
persistencia backend
↓
getEntitlement()
↓
frontend refleja el plan verdadero
```

Una URL como:

```text
?checkout=success
```

no debe conceder capacidades por sí sola.

---

## 14. P1-2 — WHATSAPP MULTI-TENANT Y DELIVERY

Este fue uno de los bloques más importantes.

CREA OS había conseguido previamente conectar WhatsApp de extremo a extremo, pero Codex detectó que había varios comportamientos peligrosos para escalar a muchos tenants.

---

## 15. FALLBACK DE NÚMERO INCORRECTO

Antes existía la posibilidad de que si el canal original no estaba operativo, el sistema seleccionara otro canal activo.

Para un SaaS multi-tenant esto es peligroso.

Podría producir:

```text
conversación A
→ canal original falla
→ sistema usa otro número
```

Eso podía provocar respuestas enviadas desde una identidad incorrecta.

---

## 16. SOLUCIÓN DE CANAL ORIGINAL

La conversación debe conservar su:

```text
whatsappChannel
```

El outbound debe comprobar:

```text
conversation
tenant
channel
credentials
```

Si el canal no es válido:

```text
409
```

o estado equivalente.

No debe seleccionar silenciosamente otro número.

---

## 17. ASSIGNEDTO CROSS-TENANT

Codex encontró también que valores como:

```text
assignedTo
```

podían requerir validaciones más estrictas.

Se implementó una validación central.

El usuario asignado debe:

- existir;
- estar activo;
- pertenecer al mismo negocio.

---

## 18. ONBOARDING WHATSAPP

El proceso fue endurecido.

Conceptualmente:

```text
pending
↓
in_progress
↓
credenciales válidas
↓
active/completed
```

Si algo falla:

```text
error/failed
```

No debe marcarse un canal como activo antes de que sus credenciales sean realmente válidas.

---

## 19. REVOCACIÓN Y ROTACIÓN

Se añadieron controles para:

- rotación;
- revocación;
- desconexión;
- suspensión;
- referencias de credenciales.

El sistema pasó a evitar reutilizar credenciales marcadas como revocadas.

---

## 20. WEBHOOK → PERSISTENCIA → COLA

Antes existía riesgo de contestar:

```text
HTTP 200
```

antes de persistir de forma segura el evento.

El flujo se endureció a algo equivalente a:

```text
Webhook autenticado
↓
resolver tenant/canal
↓
persistir InboundEvent
↓
encolar trabajo
↓
HTTP 200
↓
worker procesa
```

La IA ya no debe bloquear la respuesta del webhook.

---

## 21. INBOUND EVENT

Se fortaleció el uso de:

```text
InboundEvent
```

para proporcionar:

- idempotencia;
- persistencia;
- estado;
- recuperación.

Los eventos duplicados deben convertirse en no-op.

---

## 22. OUTBOUND EVENT

También se fortaleció:

```text
OutboundEvent
```

con estados más explícitos.

Entre ellos:

```text
pending
enqueue_failed
queued
processing
sending
retryable_failed
sent
permanently_failed
delivery_uncertain
skipped
```

El estado histórico:

```text
failed
```

quedó principalmente por compatibilidad.

---

## 23. JOB ID DETERMINÍSTICO

Se introdujo una relación determinística entre evento y trabajo.

Esto ayuda a evitar envíos duplicados.

---

## 24. RETRIES

Los errores recuperables pueden reintentarse.

Ejemplos:

```text
429
5xx
timeouts antes de iniciar envío
errores temporales de red
```

Los errores permanentes no deben reintentarse infinitamente.

---

## 25. SEMÁNTICA AT-MOST-ONCE

Se tomó una decisión conservadora.

En un timeout ambiguo después de iniciar la entrega:

```text
delivery_uncertain
```

La razón:

Si el proveedor recibió el mensaje pero el sistema perdió la respuesta, reenviarlo automáticamente puede duplicar el mensaje al cliente.

CREA OS prioriza:

> evitar duplicados antes que reenviar automáticamente cuando la entrega no puede conocerse con certeza.

---

## 26. RECEIPTS DE GUPSHUP

Se mejoró el tratamiento de eventos de estado.

El sistema puede reconciliar estados cuando Gupshup devuelve información correlacionable.

Ejemplo:

```text
sent
delivered
read
failed
```

Esto permite cerrar algunos:

```text
delivery_uncertain
```

cuando llega evidencia posterior.

---

## 27. P1-3 — AUTENTICACIÓN Y SEGURIDAD

Este bloque es particularmente importante para las fallas actuales.

Codex endureció la autenticación.

Anteriormente había más dependencia de:

```text
localStorage
```

para manejar tokens.

El sistema pasó hacia un modelo con:

```text
Access token → memoria
Refresh token → cookie HttpOnly
```

---

## 28. REFRESH TOKEN

Se implementó:

- refresh token HttpOnly;
- rotación;
- logout;
- limpieza de tokens antiguos;
- endurecimiento contra XSS.

Esto mejora significativamente la seguridad.

Pero también aumenta la importancia de que estén perfectamente coordinados:

```text
frontend
backend
cookie
CORS
dominio
Railway
```

---

## 29. CORS

Codex endureció CORS.

Antes existían patrones demasiado permisivos.

Después el origen debía ser explícitamente autorizado.

Esto reduce el riesgo de que dominios aparentemente similares sean aceptados.

---

## 30. CSP Y SECURITY HEADERS

También se reforzaron:

- CSP;
- security headers;
- WebView;
- configuraciones Android.

---

## 31. HEALTHCHECKS

Se añadieron / endurecieron endpoints como:

```text
/health/live
/health/ready
```

El worker debía verificar componentes como:

- MongoDB;
- Redis;
- colas;
- consumidores;
- dead-letter.

---

## 32. RAILWAY

También se trabajó para lograr builds más reproducibles.

Se utilizaron configuraciones equivalentes a:

```text
npm ci
```

y Node fijado.

Se corrigieron comportamientos de despliegue y runtime.

---

## 33. P2-A — RUNTIME / HEALTH / PRODUCCIÓN

Este bloque cerró problemas relacionados con:

- healthchecks;
- CORS;
- Railway;
- despliegues reproducibles;
- endpoints legacy;
- validación de runtime.

La suite llegó aproximadamente a:

```text
119 suites
1047 tests
```

todo aprobado en ese momento.

---

## 34. P2-B — IA, MEMORIA Y ANDROID

Codex trabajó también en:

### IA

- concurrencia;
- persistencia;
- historial;
- memoria incremental;
- procesamiento más seguro.

### Android

- deep links;
- seguridad;
- manifest;
- compilación.

Los resultados llegaron a:

```text
Backend:
121 suites
1054 tests

Frontend:
11 archivos
55 tests
```

en verde.

---

## 35. P3 — DEUDA TÉCNICA

Codex trabajó posteriormente en:

- eliminación de scaffolding Supabase sin consumidores;
- limpieza de índices huérfanos;
- documentación;
- warnings;
- minificación Android;
- reducción de recursos;
- configuraciones residuales.

El bloque quedó finalmente consolidado.

---

## 36. ENTORNO ANDROID MIGRADO COMPLETAMENTE A C:\

Se detectaron dependencias del entorno antiguo en E:.

Finalmente se estableció:

```text
JAVA_HOME:
C:\Java\jdk-21.0.12.1+1
```

Gradle cache:

```text
C:\PROYECTOS\CREA-OS\Gradle-cache
```

Android SDK:

```text
C:\PROYECTOS\CREA-OS\android_sdk
```

Android user home:

```text
C:\PROYECTOS\CREA-OS\.android-user
```

Se verificó:

```text
assembleDebug: BUILD SUCCESSFUL
```

y Codex concluyó:

```text
CREA OS 100% DESDE C: SÍ
```

---

## 37. ESTADO DE PRUEBAS ALCANZADO

Durante los distintos bloques la suite fue creciendo.

Se alcanzaron valores cercanos a:

```text
Backend:
122 suites
1056 tests

Frontend:
12 archivos
57 tests
```

Además:

```text
TypeScript OK
node --check OK
git diff --check OK
Capacitor OK
Android debug OK
```

Esto demuestra que el problema actual no necesariamente es un error sintáctico o una función aislada.

Puede ser un problema:

```text
runtime
+
contrato frontend/backend
+
datos existentes
+
sesión
+
infraestructura
+
estado distribuido
```

---

## 38. SITUACIÓN ACTUAL

Después de esas mejoras se comenzó a probar CREA OS manualmente.

La aplicación también está siendo utilizada en prueba cerrada de Google Play.

Durante pruebas reales aparecieron cinco fallas importantes.

---

## 39. FALLA ACTUAL 1 — NO SE PUEDE REGISTRAR UN TENANT NUEVO

Al intentar crear un usuario/tenant nuevo aparece:

```text
Datos inválidos
```

incluso utilizando datos aparentemente correctos.

Esto impide completar normalmente el onboarding de un tenant nuevo.

### Hipótesis a investigar

#### A. Hardening de tenant demasiado temprano

Podría existir una dependencia circular:

```text
usuario nuevo
↓
necesita Business
↓
Business necesita usuario/tenant
↓
middleware exige Business
↓
registro falla
```

#### B. Contrato frontend/backend desalineado

Frontend y backend podrían esperar payloads distintos.

#### C. Validación demasiado estricta

Revisar:
- Joi;
- Zod;
- express-validator;
- schema Mongo;
- normalizadores;
- sanitización;
- reglas de contraseña;
- email;
- teléfono;
- business name.

#### D. Error específico oculto por el frontend

El backend podría devolver información útil y el frontend convertirla en:

```text
Datos inválidos
```

---

## 40. FALLA ACTUAL 2 — RESPUESTAS IA INTERMITENTES

Comportamiento observado:

```text
mensaje A → IA responde
mensaje B → IA responde
mensaje C → no responde
mensaje D → vuelve a responder
```

No es una caída total.

### Flujo a trazar

```text
WhatsApp
↓
Gupshup
↓
Webhook
↓
validación
↓
InboundEvent
↓
persistencia
↓
Redis
↓
BullMQ
↓
Inbound Worker
↓
Lead
↓
Conversation
↓
Business
↓
Entitlement
↓
Business Brain
↓
IA
↓
OutboundEvent
↓
Outbound Queue
↓
Outbound Worker
↓
Canal original
↓
Gupshup
↓
WhatsApp
```

### Posibles causas

- `InboundEvent` duplicado;
- providerMessageId;
- jobs stalled;
- jobs failed;
- Redis;
- BullMQ;
- worker desconectado;
- channel inactive;
- `whatsappChannel` nulo;
- `businessId` incompatible;
- `tenantId` incompatible;
- entitlement;
- IA deshabilitada;
- automatización deshabilitada;
- OutboundEvent;
- delivery_uncertain;
- channel reassignment;
- credentialReference;
- rate limit OpenAI;
- timeout;
- conversación histórica creada antes del hardening.

---

## 41. FALLA ACTUAL 3 — MENSAJES MANUALES INTERMITENTES

Desde CREA OS un usuario intenta escribir manualmente a un lead.

Comportamiento:

```text
unas veces envía
unas veces falla
unas veces se interrumpe
```

### Posible causa compartida con IA

Ambas rutas terminan utilizando:

```text
OutboundEvent
↓
Outbound Queue
↓
Outbound Worker
↓
Channel
↓
Gupshup
```

Por tanto, si ambas fallan intermitentemente, el problema podría estar después de la generación del mensaje.

No necesariamente en OpenAI.

Claude debe comparar:

```text
mensaje IA exitoso
mensaje IA fallido
mensaje manual exitoso
mensaje manual fallido
```

y encontrar el primer punto donde divergen.

---

## 42. DATOS HISTÓRICOS COMO POSIBLE CAUSA

Antes del hardening se crearon:

- tenants;
- conversaciones;
- leads;
- canales;
- WhatsAppConnections.

Los nuevos contratos pueden esperar campos que los registros históricos no tienen.

Ejemplos:

```text
conversation.whatsappChannel
channel.tenantId
channel.businessId
credentialReference
provider
status
```

Esto puede explicar por qué algunas conversaciones funcionan y otras no.

---

## 43. FALLA ACTUAL 4 — LEADS / PIPELINE / STATS QUEDAN CARGANDO

Actualmente se ha observado:

```text
Leads → cargando...
Pipeline → cargando...
Stats → cargando...
```

y nunca finaliza.

### Hipótesis fuerte: auth

```text
Access token
↓
expira / pierde validez
↓
request recibe 401
↓
frontend intenta refresh
↓
cookie no llega o refresh falla
↓
interceptor vuelve a intentar
↓
loading nunca se resuelve
```

### Inspeccionar especialmente

```text
client.ts
auth.ts
interceptors
refresh
business/current
auth/me
leads
pipeline
stats
```

Y capturar respuestas HTTP reales:

```text
200
400
401
403
409
429
500
502
503
```

No asumir que el problema es React.

---

## 44. FALLA ACTUAL 5 — “DEMASIADOS INTENTOS”

Comportamiento observado:

```text
cierra sesión
↓
intenta ingresar nuevamente
↓
recibe:
Demasiados intentos.
Vuelve a intentarlo en 15 minutos.
```

Incluso si aparentemente es el primer intento manual.

### Hipótesis principal: rate limiter + proxy

Railway opera detrás de proxies.

Si Express no está configurado correctamente:

```text
req.ip
```

puede representar al proxy y no al usuario real.

Entonces múltiples usuarios pueden compartir la misma key del rate limiter.

Ejemplo:

```text
Usuario A
Usuario B
Usuario C
Usuario D
        ↓
Railway Proxy
        ↓
misma IP aparente
        ↓
rate limiter
        ↓
429
```

### Revisar trust proxy

```javascript
app.set('trust proxy', ...)
```

y:

```text
req.ip
req.ips
X-Forwarded-For
```

No debe corregirse arbitrariamente sin comprender la topología de Railway.

### Segunda hipótesis: refresh storm

```text
5 requests simultáneas
↓
5 reciben 401
↓
5 ejecutan refresh
↓
rotación de refresh token
↓
solo una funciona
↓
otras fallan
↓
retry
↓
retry
↓
retry
↓
rate limiter
↓
429
```

Esto es común cuando no existe un mecanismo tipo:

```text
single-flight refresh
```

---

## 45. RELACIÓN POTENCIAL ENTRE LAS CINCO FALLAS

Claude NO debe tratarlas inicialmente como cinco bugs aislados.

Puede existir una combinación de solo 2 o 3 causas raíz.

Ejemplo:

```text
AUTH / COOKIE / REFRESH
        ↓
Leads cargando
Pipeline cargando
Stats cargando
429 login
```

y otra:

```text
CANAL / WORKER / OUTBOUND
        ↓
IA intermitente
mensajes manuales intermitentes
```

y una tercera:

```text
TENANT HARDENING
        ↓
registro nuevo bloqueado
```

---

## 46. ESTADO ACTUAL DE PRODUCCIÓN

Es importante determinar exactamente qué versión está activa.

No asumir que:

```text
origin/main == producción
```

### Backend

```text
local HEAD
origin/main
Railway deployment commit
```

### Frontend

```text
local HEAD
origin/main
creaosapp.com deployment
```

### Android

```text
AAB actualmente publicado en prueba cerrada
versionCode
versionName
commit aproximado
```

---

## 47. POSIBLE DESINCRONIZACIÓN ENTRE VERSIONES

Puede existir:

```text
Frontend nuevo
+
Backend antiguo
```

o:

```text
Backend nuevo
+
APK antiguo
```

o:

```text
Web actualizado
+
APK de Play Console todavía con versión anterior
```

En un cambio grande de autenticación esto puede causar muchos síntomas.

---

## 48. PRUEBA CERRADA DE GOOGLE PLAY

CREA OS está actualmente en prueba cerrada.

Los testers todavía no están ejecutando campañas comerciales reales.

Esto permite cierto margen para diagnóstico.

Sin embargo:

> no debe desplegarse experimentalmente código no validado solo porque sea una prueba cerrada.

Las correcciones deben conservar estabilidad.

---

## 49. PROBLEMA DE MIGRACIÓN DE SESIONES ANTIGUAS

Después de cambiar:

```text
refresh token localStorage
```

hacia:

```text
HttpOnly cookie
```

usuarios que tengan sesiones antiguas pueden quedar en estados inconsistentes.

Claude debe determinar si la solución requiere:

```text
forced logout único
```

para sesiones antiguas.

Eso sería aceptable.

Lo que no sería aceptable es mantener indefinidamente dos sistemas de sesión incompatibles.

---

## 50. PRINCIPIO DE SOLUCIÓN

No queremos:

```text
quitar HttpOnly
quitar CORS
quitar tenant validation
quitar channel validation
quitar entitlement
quitar queues
```

solo para que vuelva a funcionar.

Queremos:

```text
HttpOnly correcto
CORS correcto
multi-tenant correcto
channel validation correcta
entitlement correcto
queues correctas
+
experiencia funcional
```

---

## 51. QUÉ NO DEBE HACER CLAUDE CODE

Durante la fase inicial:

```text
NO rollback general.
NO checkout a commits antiguos.
NO restaurar arquitectura vieja.
NO quitar seguridad para resolver síntomas.
NO deshabilitar rate limiting.
NO eliminar tenant validation.
NO volver tokens a localStorage.
NO permitir fallback silencioso de WhatsApp.
NO volver a webhook síncrono.
NO quitar BullMQ.
NO usar números WhatsApp alternativos automáticamente.
NO hacer force push.
NO borrar tenants.
NO borrar conversaciones.
NO borrar leads.
NO borrar MongoDB.
NO cambiar de rama sin autorización.
NO utilizar E:\.
```

---

## 52. FILOSOFÍA DE REPARACIÓN

Para cada problema:

```text
1. Reproducir.
2. Capturar evidencia.
3. Encontrar el primer punto de falla.
4. Determinar causa raíz.
5. Diseñar corrección mínima.
6. Mantener hardening.
7. Añadir prueba.
8. Implementar.
9. Ejecutar suite.
10. Validar extremo a extremo.
```

---

## 53. BLOQUE 1 RECOMENDADO — AUTENTICACIÓN Y SESIONES

Orden recomendado:

```text
Login
Refresh
Logout
Cookie
CORS
Rate limiter
Railway proxy
```

Porque potencialmente explica tres síntomas:

```text
429
paneles cargando
sesiones inconsistentes
```

### Pruebas mínimas

```text
login exitoso
logout
login inmediato nuevamente
```

```text
login
esperar refresh
continuar navegando
```

```text
5 requests simultáneas con access token expirado
```

Debe ocurrir:

```text
1 refresh
```

no:

```text
5 refresh simultáneos
```

---

## 54. OBSERVABILIDAD DEL RATE LIMIT

Registrar temporalmente, sin exponer secretos:

```text
endpoint
req.ip
req.ips
x-forwarded-for normalizado
rate-limit key
userId si existe
timestamp
```

Esto permitiría saber si varios usuarios están siendo agrupados.

---

## 55. BLOQUE 2 — REGISTRO DE NUEVO TENANT

Después de estabilizar autenticación:

```text
registrar usuario
↓
crear tenant
↓
crear negocio
↓
Starter
↓
crear sesión
↓
login
↓
dashboard
```

Claude debe probar el onboarding completo desde cero.

---

## 56. BLOQUE 3 — MENSAJERÍA

Crear una traza única.

Ejemplo conceptual:

```text
traceId
```

para seguir:

```text
InboundEvent
Job inbound
AI
OutboundEvent
Job outbound
Gupshup
Receipt
```

Así se puede identificar exactamente dónde desaparece un mensaje.

---

## 57. MATRIZ DE PRUEBAS DE MENSAJERÍA

| Caso | IA | Manual | Resultado |
|---|---|---|---|
| tenant actual | sí | — | debe responder |
| tenant actual | — | sí | debe enviar |
| conversación nueva | sí | sí | debe funcionar |
| conversación histórica | sí | sí | debe funcionar |
| canal activo | sí | sí | debe funcionar |
| canal desconectado | sí | sí | debe fallar explícitamente |
| tenant incorrecto | sí | sí | debe bloquearse |

---

## 58. MIGRACIÓN DE DATOS HISTÓRICOS

Si Claude confirma que documentos antiguos no cumplen el nuevo contrato:

NO relajar las validaciones nuevas.

Crear una migración explícita.

Ejemplo:

```text
Conversation antigua
↓
resolver canal real
↓
establecer whatsappChannel
↓
establecer businessId/tenantId
↓
validar credencial
↓
marcar migrada
```

---

## 59. ESTADO DE LA AUDITORÍA DE BUSINESS BRAIN

Existe además una auditoría reciente sobre:

- Identidad del negocio;
- Nombre del agente;
- Archivos;
- PDF informativo;
- Inventario;
- Políticas;
- FAQ.

El resultado aproximado fue:

```text
78% funcional
```

Pero este bloque es independiente de las cinco fallas operativas actuales.

No debe mezclarse con el diagnóstico principal salvo que exista evidencia directa.

---

## 60. IDENTIDAD DEL NEGOCIO

Actualmente se confirmó que la IA recibe campos como:

```text
name
agentName
productDescription
averageTicket
currency
targetCustomer
website
facebookUrl
instagramUrl
tiktokUrl
aiInstructions
```

---

## 61. AGENT NAME

Actualmente:

```text
agentName configurado
→ funciona
```

pero:

```text
agentName vacío
→ fallback Alex
```

Ese comportamiento deberá mejorarse posteriormente.

No debería afectar las cinco fallas actuales.

---

## 62. PDF INFORMATIVO

Actualmente:

```text
PDF
↓
pdf-parse
↓
texto
↓
resumen
↓
Business.pdfSummary
↓
prompt IA
```

Limitación:

```text
no RAG completo
no embeddings
no OCR
```

Esto también es una mejora futura y no debe mezclarse con el diagnóstico crítico actual.

---

## 63. PRODUCT INTELLIGENCE

Actualmente la IA dispone de herramientas como:

```text
search_products
check_stock
get_price
```

filtradas por negocio.

Eso debe conservarse.

---

## 64. MULTI-TENANT DEL BUSINESS BRAIN

La auditoría confirmó que:

- identidad;
- productos;
- políticas;
- FAQ;
- herramientas;

están mayormente filtradas por tenant.

Se detectó otro problema distinto:

```text
Cloudinary URLs públicas
```

que deberá corregirse posteriormente.

No mezclarlo ahora si no tiene relación directa con las cinco fallas operativas.

---

## 65. PRIORIDADES ACTUALES

### PRIORIDAD 0

**Login / Auth / 429**

Porque puede impedir utilizar toda la plataforma.

### PRIORIDAD 0

**Registro de tenant**

Porque bloquea nuevos usuarios.

### PRIORIDAD 1

**IA intermitente**

Porque afecta la propuesta central de CREA OS.

### PRIORIDAD 1

**Mensajería manual**

Porque impide que un humano pueda asumir la conversación.

### PRIORIDAD 1

**Leads / Pipeline / Stats**

Porque afecta operación comercial.

---

## 66. OBJETIVO PARA CLAUDE CODE

Claude debe realizar una investigación profunda, no superficial.

Debe responder:

### A
¿Qué ocurrió exactamente después del hardening?

### B
¿Cuáles cambios están relacionados con cada síntoma?

### C
¿Existen incompatibilidades entre frontend y backend?

### D
¿Existe incompatibilidad con datos antiguos?

### E
¿Existen problemas de sesión/cookie?

### F
¿Existe refresh storm?

### G
¿Existe rate limiter mal identificado detrás de Railway?

### H
¿Redis/BullMQ están perdiendo trabajos?

### I
¿Los workers están siempre disponibles?

### J
¿Conversation.whatsappChannel existe en todos los documentos relevantes?

### K
¿Los deploys actualmente activos corresponden a `origin/main`?

---

## 67. FORMATO DE INVESTIGACIÓN EXIGIDO

Para cada falla entregar:

```text
SÍNTOMA
↓
REPRODUCCIÓN
↓
REQUEST
↓
ENDPOINT
↓
RESPONSE
↓
LOG
↓
ARCHIVO
↓
LÍNEA / FUNCIÓN
↓
CAUSA RAÍZ
↓
CAMBIO QUE LA INTRODUJO O EXPUSO
↓
SOLUCIÓN RECOMENDADA
↓
RIESGO DE LA SOLUCIÓN
↓
TEST NECESARIO
```

---

## 68. DISTINGUIR HECHOS DE HIPÓTESIS

Claude debe clasificar cada conclusión:

```text
CONFIRMADO
EVIDENCIA FUERTE
HIPÓTESIS
DESCARTADO
```

No queremos conclusiones como:

```text
probablemente Redis
```

sin evidencia.

---

## 69. NO DETENERSE EN EL PRIMER ERROR

Ejemplo:

Si descubre:

```text
401
```

no debe simplemente modificar el frontend.

Debe continuar:

```text
¿Por qué 401?
↓
¿token expiró?
↓
¿refresh ocurrió?
↓
¿cookie llegó?
↓
¿cookie fue aceptada?
↓
¿refresh rotó?
↓
¿otro request usó token antiguo?
↓
¿rate limiter intervino?
```

Ese nivel de análisis es requerido.

---

## 70. ESTADO FINAL QUE BUSCAMOS

CREA OS debe terminar con:

```text
registro tenant         ✅
login                    ✅
logout                   ✅
relogin inmediato        ✅
refresh                  ✅
Leads                    ✅
Pipeline                 ✅
Stats                    ✅
IA WhatsApp              ✅
mensajes manuales        ✅
multi-tenant             ✅
canal original           ✅
entitlement              ✅
Redis/BullMQ              ✅
idempotencia             ✅
HttpOnly                 ✅
CORS estricto            ✅
rate limiting            ✅
Railway                  ✅
Android                  ✅
```

---

## 71. INSTRUCCIÓN DEFINITIVA PARA CLAUDE CODE

El trabajo realizado por Codex debe considerarse una **nueva base arquitectónica**, no un error que deba deshacerse.

El objetivo es:

> estabilizar CREA OS sobre esa arquitectura.

No volver al pasado.

No sacrificar:

- seguridad;
- multi-tenant;
- integridad;
- idempotencia;
- aislamiento;
- control de canales;
- entitlement;
- autenticación segura.

---

## 72. PRIMER TRABAJO QUE DEBE HACER CLAUDE

Antes de modificar archivos:

1. inspeccionar ambos repositorios;
2. obtener `git log`;
3. identificar commits P0–P3;
4. reconstruir cambios relevantes;
5. comprobar versión local;
6. comprobar `origin/main`;
7. comprobar runtime de Railway;
8. comprobar versión frontend desplegada;
9. reconstruir autenticación;
10. reconstruir flujo de registro;
11. reconstruir mensajería;
12. revisar logs;
13. identificar causas raíz.

---

## 73. ENTREGA QUE ESPERAMOS PRIMERO

Claude debe entregarnos un diagnóstico parecido a:

```text
CAUSA RAÍZ 1
Auth refresh concurrency

Afecta:
- Leads
- Pipeline
- Stats
- login 429

Evidencia:
...

CAUSA RAÍZ 2
Contrato de creación de Business

Afecta:
- registro tenant

Evidencia:
...

CAUSA RAÍZ 3
Conversaciones históricas sin whatsappChannel

Afecta:
- IA intermitente
- mensajes manuales

Evidencia:
...
```

Eso sería mucho más valioso que comenzar a editar 50 archivos sin comprender la causa.

---

## 74. DESPUÉS DEL DIAGNÓSTICO

Recién entonces dividir la reparación.

Recomendación:

```text
BLOQUE A
AUTH + REFRESH + 429

BLOQUE B
REGISTRO / ONBOARDING TENANT

BLOQUE C
MENSAJERÍA IA + MANUAL

BLOQUE D
LEADS / PIPELINE / STATS

BLOQUE E
VALIDACIÓN INTEGRAL
```

Cada bloque debe:

```text
diagnosticar
→ corregir
→ test focalizado
→ test general
→ commit
→ push
→ deploy
→ smoke test
```

No juntar cientos de cambios nuevamente.

---

## 75. CRITERIO DE ÉXITO

No considerar reparado porque:

```text
npm test pasa
```

El criterio real será:

### Tenant nuevo

```text
registro real
→ business creado
→ Starter asignado
→ login
→ dashboard
```

### Usuario existente

```text
logout
→ login inmediato
→ sin 429
```

### Sesión

```text
token expira
→ refresh
→ navegación continúa
```

### WhatsApp IA

```text
lead escribe
→ webhook
→ IA
→ respuesta real
```

### Mensaje manual

```text
usuario CREA OS escribe
→ outbound
→ Gupshup
→ teléfono recibe
```

### Navegación

```text
Misión
→ Leads
→ Pipeline
→ Stats
→ Leads
```

sin cargas infinitas.

---

## 76. CONCLUSIÓN

El trabajo realizado por Codex mejoró significativamente la arquitectura de CREA OS.

Transformó partes que estaban funcionando de manera práctica pero todavía frágil en una arquitectura mucho más seria:

```text
multi-tenant
+
fail-closed
+
event driven
+
colas
+
idempotencia
+
entitlement backend
+
cookies HttpOnly
+
CORS estricto
+
healthchecks
+
build reproducible
+
entorno C:\
```

El problema actual no debe interpretarse como:

> “Codex dañó CREA OS y hay que volver atrás.”

Debe interpretarse como:

> CREA OS atravesó un hardening arquitectónico profundo y ahora debemos cerrar las incompatibilidades que ese endurecimiento dejó expuestas entre runtime, contratos, datos existentes, autenticación, workers y frontend.

La misión de Claude Code será **terminar esa transición**.

La meta no es recuperar el CREA OS anterior.

La meta es lograr:

# CREA OS endurecido + estable + funcional + multi-tenant + listo para escalar.

---

## 77. ADENDA (16/sep/2026) — Deploy roto de Railway: diagnosticado y resuelto

Se confirmó que `origin/main` NO coincidía con lo desplegado en Railway: el
backend y el worker llevaban >24h atascados en `e81bf4b` (P1-3), con 3
deploys seguidos fallando (P2-A `4dbfcbf`, P2-B `c2ade84`, P3 `0ca4c61`).

**Causa raíz confirmada:** `4dbfcbf` cambió `buildCommand` en
`railway.toml`/`railway.worker.toml` de `npm install --production=false` a
`npm ci --omit=dev`, buscando builds reproducibles (ver
`src/config/deployment.test.js`, que fijaba ese contrato). Ese comando
choca con un cache mount de Nixpacks en `/app/node_modules/.cache`:
`npm ci` intenta borrar ese directorio primero y falla con
`EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'` —
100% reproducible, confirmado en los 3 intentos de deploy.

**Solución aplicada:** revertir a `npm install --production=false` (opción
(a) de las 2 evaluadas) para destrabar producción de inmediato.

**Mejora técnica pendiente (opción (b), NO aplicada todavía):** mover el
install a un `nixpacks.toml` con `[phases.install]` en vez de
`buildCommand`, para recuperar `npm ci --omit=dev` (reproducibilidad
exacta del lockfile + imagen sin devDependencies) sin duplicar la fase de
instalación que Nixpacks ya detecta solo — eso debería eliminar el
segundo `RUN` que hoy monta `/app/node_modules/.cache` y choca con la
limpieza de `npm ci`. No se pudo verificar en este entorno por falta de
`nixpacks` CLI y de un daemon de Docker corriendo — requiere probarse
con un deploy real antes de adoptarlo.

---

## 78. ADENDA (17/sep/2026) — Bloque A resuelto: rate limiter compartido + falta de manejo de errores en frontend

Con el deploy ya destrabado (adenda 77), se implementaron las 2 causas
raíz del Bloque A identificadas en el diagnóstico original (Falla 4:
Leads/Pipeline/Stats cargando infinito; Falla 5: 429 en login):

**PARTE 1 (creaos-backend, branch `fix/rate-limit-auth-isolation`):**
`/api/v1/auth/*` deja de compartir presupuesto con el resto de la API.
Se agregó `rateLimitAuthGeneral` (balde propio, 50 req/15min por IP) y un
`skip` en `rateLimitGeneral` (`debeOmitirRateLimitGeneral()`) que excluye
`/api/v1/auth/*` de su balde de 100 req/15min por usuario.
`rateLimitLogin` (5 intentos/15min por email, fuerza bruta) queda
intacto, sin cambios. También se corrigió `apiFetch` (frontend,
`client.ts`) para que deje de adjuntar `Authorization: Bearer` en
llamadas a `/api/v1/auth/*` — ahí no hay sesión propia (login, register)
o se identifica por la cookie HttpOnly (refresh, logout), y adjuntar un
token viejo hacía que el rate limiter contara ese login contra el balde
ya agotado del usuario.

**PARTE 2 (crea-os-ignite-main, branch `fix/frontend-loading-error-handling`):**
`try/catch/finally` en `load()` (leads.tsx), `loadBoard()` (pipeline.tsx)
y el efecto de carga de `stats.tsx` — antes, un rechazo de cualquier
promesa del `Promise.all` (429, 401, 500, red) dejaba `setLoading(false)`
sin ejecutarse nunca, mostrando el spinner cargando para siempre.

**Mejora de infraestructura de testing pendiente (NO aplicada, decisión
explícita del usuario 17/sep/2026):** el test que idealmente probaría
PARTE 2 end-to-end (mockear un 429/401 en una llamada paralela y
verificar que el componente sale de `loading` y muestra un estado de
error) requiere renderizar los componentes de React reales. El repo de
frontend (`crea-os-ignite-main`) documenta explícitamente en
`vitest.config.ts` que sus tests son "de lógica pura... no de
renderizado de componentes" — no hay jsdom, no hay
`@testing-library/react`, y `include` está limitado a `*.test.ts` (no
`.tsx`). Agregar tests de renderizado de componentes requiere meter esa
infraestructura (nueva dependencia + entorno DOM) como una tarea
aparte, deliberada, no colada dentro de un fix puntual. Mientras tanto,
PARTE 2 se validó por lectura directa de código (el mismo patrón
`try/catch/finally` que ya usa `loadMore()` en `leads.tsx`, líneas
130-149, sin tests de render tampoco) más el paso de la suite completa
(lógica pura) y de TypeScript.
