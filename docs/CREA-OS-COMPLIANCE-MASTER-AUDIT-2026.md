# CREA OS — Auditoría Maestra de Compliance 2026

**Fecha de corte:** 11 de octubre de 2026

**Modo:** solo lectura; diagnóstico, sin implementación

**Alcance autorizado:** `C:\PROYECTOS\CREA-OS\creaos-backend` y `C:\PROYECTOS\CREA-OS\crea-os-ignite-main`

**Exclusiones:** no se inspeccionó ni utilizó `E:\`; no se accedió a consolas externas, contratos, bases de datos productivas ni secretos.
**Criterio:** la existencia de una pantalla o texto legal no se considera cumplimiento si falta evidencia persistente, trazable y ejecutable en backend.

## 1. Executive Summary

CREA OS dispone de una base técnica sólida para un SaaS multi-tenant: autenticación con refresh tokens rotatorios, autorización server-side, aislamiento por negocio, validación fail-closed de webhooks, colas durables, protección de archivos, firma temporal de URLs, cifrado de credenciales de canales y hardening Android. Estas áreas cuentan con código, tests y commits previos y se marcan como **VERIFICADO POR AUDITORÍA PREVIA ✅** cuando corresponde.

La preparación de compliance, sin embargo, no está al mismo nivel. Se identificaron **48 hallazgos: 8 P0, 18 P1, 15 P2 y 7 P3**. Los riesgos inmediatos son: ausencia de evidencia persistente de aceptación legal; falta de un flujo real de eliminación de cuenta y datos; ausencia de opt-in/opt-out y lista de supresión para WhatsApp; vulnerabilidades críticas conocidas en dependencias backend y Android; tokens OAuth/webhook almacenados en texto claro; copias locales con datos personales sin evidencia de gobierno; y falta de validación de la declaración Data Safety de Google Play frente a permisos y tratamiento reales.

**Conclusión de lanzamiento:** técnicamente robusto en aislamiento y mensajería durable, pero **no listo para declarar compliance integral ni para expansión internacional** hasta cerrar los P0 y establecer gobierno de privacidad, retención, incidentes y terceros.

## 2. Arquitectura actual

```text
USUARIO WEB / ANDROID CAPACITOR
        |
        v
FRONTEND React + Vite + TanStack Query (Vercel)
        | HTTPS, cookie refresh HttpOnly, access token en memoria
        v
BACKEND Node.js + Express (Railway API)
        |-- autenticación JWT / RBAC / tenant middleware
        |-- webhooks Meta, TikTok, Gupshup, Stripe, Mercado Pago
        |-- servicios CRM, inventario, suscripciones, IA, RAG
        |
        +--> MongoDB / Mongoose
        +--> Redis + BullMQ
        +--> Railway Worker
        |       |-- inbound / outbound / dead-letter
        |       |-- automatizaciones / RAG / reservas
        |
        +--> OpenAI
        +--> Gupshup / WhatsApp / Meta / TikTok
        +--> Cloudinary authenticated + storage documental S3-compatible
        +--> Resend / Firebase FCM / Stripe / Mercado Pago
```

La API y el worker están separados mediante `railway.toml` y `railway.worker.toml`. La persistencia principal usa MongoDB; Redis/BullMQ soporta refresh sessions, colas y ejecución asíncrona. El frontend está vinculado a Vercel. La app Android empaqueta el frontend con Capacitor y usa el package `com.creaos.app`.

## 3. Sistemas y proveedores

| Componente | Tecnología/proveedor | Función | Evidencia | Estado de compliance |
|---|---|---|---|---|
| Frontend | React, Vite, TanStack Query, Vercel | UI web y bundle Capacitor | `package.json`, `.vercel/project.json` | 🟡 PARCIAL |
| Backend | Node.js, Express, Railway | API y lógica de negocio | `src/app.js`, `railway.toml` | 🟡 PARCIAL |
| Base de datos | MongoDB/Mongoose | Datos de cuenta, CRM, mensajes, configuración | `src/models/**` | 🟡 PARCIAL |
| Cache/colas | Redis, BullMQ | Sesiones, inbound/outbound, jobs | `src/queues/**`, `src/workers/**` | ✅ IMPLEMENTADO técnicamente |
| IA | OpenAI | Respuestas, tools, RAG y clasificación | `src/services/ai.service.js`, `src/tools/index.js` | 🟡 PARCIAL |
| WhatsApp | Gupshup/Meta | Mensajería y templates | `src/modules/channels/**`, `src/webhooks/**` | 🟡 PARCIAL |
| Archivos | Cloudinary authenticated; S3-compatible | Imágenes, video, brochure/documentos | `src/services/cloudinary.service.js`, `src/services/documentStorage.service.js` | ✅ IMPLEMENTADO técnicamente |
| Email | Resend | Verificación, recuperación y comunicaciones | `src/services/email.service.js` | 🟡 PARCIAL |
| Push | Firebase FCM | Push Android | `src/services/pushNotification.service.js` | 🟡 PARCIAL |
| Captura de leads | Meta Graph / TikTok | Webhooks e importación de leads | `src/webhooks/**`, `src/modules/integrations/**` | 🟡 PARCIAL |
| Pagos | Stripe / Mercado Pago | Suscripciones y estados de pago | `src/modules/subscription/**` | 🟡 PARCIAL |
| Android | Capacitor, Gradle, Firebase plugin | App móvil | `android/**`, `capacitor.config.ts` | 🟡 PARCIAL |
| Analytics | No se detectó SDK activo | Analítica de producto | búsqueda en dependencias/código | ⚪ NO APLICA actualmente |
| Monitorización | Healthchecks y logs rotados | Disponibilidad y diagnóstico | `src/routes/health.routes.js`, `src/utils/logger.js` | 🟡 PARCIAL |
| Backups | Copias locales documentadas; proveedor DB externo no verificado | Recuperación | `backups/`, `docs/implementation/fase-0a-contencion-report.md` | 🔵 REQUIERE VALIDACIÓN EXTERNA |

## 4. Inventario de datos personales

| Dato | Origen | Finalidad | Tabla/archivo | Procesamiento/compartición | Retención actual | Eliminación | Riesgo |
|---|---|---|---|---|---|---|---|
| Nombre, email, teléfono de usuario | Registro/administrador | Cuenta y acceso | `User` | API, MongoDB, email | Sin plazo general | Desactivación; no borrado integral | Alto |
| Password hash y tokens hash | Usuario/sistema | Autenticación | `User`, Redis | bcrypt/JWT/Redis | Según token; cuenta sin plazo | Parcial | Alto |
| IP, agente y eventos de acceso | Request | Seguridad/rate limit | logs, rate limiter | Railway/logs/Redis | Logs 14/30 días; otros no documentados | Rotación parcial | Medio |
| Device ID y push token | Android/FCM | Notificaciones | `PushToken`, localStorage | Firebase FCM | Sin plazo formal; soft inactive | Parcial | Alto |
| Datos del lead | CRM, importación, Meta/TikTok | Gestión comercial | `Lead` | MongoDB, IA, WhatsApp | Sin plazo formal | Soft delete indefinido | Alto |
| WhatsApp ID/teléfono | Cliente/WhatsApp | Mensajería | `Lead`, `Conversation`, eventos | Gupshup/Meta, MongoDB | Sin plazo formal | No hay supresión integral | Alto |
| Conversaciones y mensajes | Cliente, agente, IA | Atención y ventas | `Conversation.messages` | OpenAI, WhatsApp, MongoDB | Sin plazo formal | Soft delete/conservación indefinida | Alto |
| Datos de calificación | IA/agente | Priorización comercial | `Conversation.qualification` | OpenAI, MongoDB | Sin plazo formal | No específica | Alto |
| Prompts, instrucciones y respuestas IA | Negocio/sistema | Automatización de ventas | Business, Conversation, logs | OpenAI/MongoDB | Sin plazo formal | No específica | Alto |
| Archivos, imágenes, videos | Negocio/usuario | Catálogo y mensajería | Business/Product/Variant | Cloudinary/S3-compatible | Sin política general | Limpieza técnica parcial | Alto |
| PDF, texto extraído, chunks, embeddings | Negocio | RAG | `BusinessDocument`, chunks | OpenAI/storage/MongoDB | Sin plazo formal | Lifecycle técnico; política ausente | Alto |
| Raw webhook payload | Meta/TikTok/Gupshup | Trazabilidad e idempotencia | `InboundEvent.rawPayload` | MongoDB/worker | Sin TTL general | No definida | Alto |
| Outbound recipient/payload/status | Usuario/IA | Entrega durable | `OutboundEvent` | Redis, Gupshup/Meta, MongoDB | Sin TTL general | No definida | Alto |
| Datos comerciales del negocio | Titular | Configuración del servicio | `Business` | MongoDB, IA, proveedores | Vida del tenant | No cascade probado | Alto |
| Productos, precios, inventario | Negocio | CRM/ventas | Product/Variant/Reservation | MongoDB/IA/WhatsApp | Sin plazo formal | Parcial | Medio |
| Pagos y suscripción | Usuario/proveedores | Facturación | Subscription/payment history | Stripe/Mercado Pago/MongoDB | Sin política fiscal regional | No específica | Alto |
| Importaciones y errores de filas | Usuario | Carga masiva | Import/error records | MongoDB | Sin plazo formal | No definida | Alto |
| Consentimiento legal | Checkbox frontend | Aceptación contractual | No persistido en backend | Solo estado UI/sesión | No existe evidencia durable | No aplica | Crítico |
| Opt-in/opt-out marketing | Cliente | Base legal WhatsApp | No se detectó modelo/registro | No implementado | No existe | No existe | Crítico |
| Logs de aplicación | Sistema | Diagnóstico | archivos/log provider | Railway/local | 14/30 días local | Rotación parcial | Medio/alto |
| Backups con PII | Operación | Recuperación | `backups/` y proveedor externo | Filesystem/proveedor DB | No documentada | No documentada | Crítico |

## 5. Data Flow Map

```text
[Usuario/cliente]
   | registro, CRM, archivos, mensajes, permisos
   v
[React/Vercel o WebView/Capacitor]
   | access token; refresh cookie; multipart; push token
   v
[Express/Railway API]
   |-- tenant + RBAC --> [MongoDB]
   |-- jobs/events --> [Redis/BullMQ] --> [Railway Worker]
   |-- prompts/context/RAG --> [OpenAI] --> respuesta/acciones CRM
   |-- mensajes/templates/media --> [Gupshup/Meta/WhatsApp]
   |-- archivos --> [Cloudinary authenticated / S3-compatible]
   |-- email --> [Resend]
   |-- push --> [Firebase FCM]
   |-- pagos --> [Stripe / Mercado Pago]
   ^
   | webhooks firmados/tokens + payloads
[Meta / TikTok / Gupshup / pagos]

Ciclo observado: CREATE -> USE -> STORE -> SHARE -> ARCHIVE parcial -> DELETE incompleto
```

## 6. Matriz de compliance

| ID | Área | Requirement | Status | Evidence | File / línea o componente | Risk | Recommended action | Priority |
|---|---|---|---|---|---|---|---|---|
| C-001 | LEGAL/BACKEND | Evidencia versionada de aceptación legal | 🔴 FALTA | El checkbox existe, pero registro no envía ni guarda versión/fecha/IP | Front `src/pages/auth/index.tsx:81,149-150,275-299`; back `src/controllers/auth.controller.js:15-20`, `src/models/user.model.js` | No puede probarse consentimiento contractual | Persistir documento, versión, fecha, contexto y separar consentimientos opcionales | P0 |
| C-002 | LEGAL/BACKEND | Eliminación de cuenta y datos asociados | 🔴 FALTA | Solo desactivación de otros usuarios; propietario no puede autoeliminarse; no hay cascade/DSAR ni URL técnica externa | `src/services/user.service.js:146-165`; rutas auth/user | Incumplimiento de derechos y Google Play | Crear workflow autenticado, validación de propiedad, cascade/anonymization, recibo y URL pública | P0 |
| C-003 | WHATSAPP | Opt-in, revocación y suppression list | 🔴 FALTA | No se encontró registro de fuente/fecha/finalidad ni procesamiento STOP/BAJA/SALIR | modelos/rutas de channels, conversation y outbound | Mensajería sin evidencia de autorización y recontacto indebido | Implementar consentimiento por canal/finalidad, suppression server-side y bloqueo antes de enqueue | P0 |
| C-004 | BACKEND | Dependencias sin vulnerabilidades críticas conocidas | ✅ IMPLEMENTADO | P0-A redujo el audit de 17 (1 critical/5 high/11 moderate) a 1 (0 critical/0 high/1 moderate). `xlsx@0.18.5` fue sustituido por SheetJS CE oficial 0.20.3, con regresión XLS/XLSX/CSV y sin advisories HIGH/CRITICAL en el árbol | `package.json`, `package-lock.json`, `src/modules/imports/spreadsheet.compatibility.test.js`; evidencia P0-A 11/10/2026 | La única vulnerabilidad backend restante es `uuid@9.0.1` MODERATE; el uso actual no entrega buffers controlados por usuario a v3/v5/v6 y su fix exige major | Mantener SCA continuo; migrar `uuid` mediante bloque separado con pruebas de compatibilidad, sin `audit fix --force` | P0 |
| C-005 | ANDROID | Runtime Android sin CVE crítica conocida | ✅ IMPLEMENTADO | `@capacitor/android`, `core` y `cli` 8.5.0 → 8.5.1; audit posterior: 0 critical; build web, 180 tests, Capacitor sync y `bundleRelease` firmado PASS | frontend `package.json`, `package-lock.json`; Android release 1.5 (7), 11/10/2026 | La CVE GHSA-rvm3-566m-v7fv quedó corregida; HIGHs restantes pertenecen a C-037 y no a Capacitor Android | Mantener patching y repetir audit/build por release | P0 |
| C-006 | DATABASE/SECURITY | Cifrado de tokens OAuth/webhook persistidos | ✅ IMPLEMENTADO EN CÓDIGO / 🔵 MIGRACIÓN PRODUCTIVA PENDIENTE | `WebhookConfig.verifyToken` y `accessToken` usan AES-256-GCM versionado con subclave HKDF por registro/campo; nuevas escrituras y actualizaciones nunca persisten plaintext; lectura legacy temporal y serialización sanitizada | `src/modules/webhooks/webhookConfig.model.js`, `webhookConfigSecrets.service.js`, `webhookConfigMigration.service.js`, `scripts/migrate-webhook-secrets.js`; evidencia P0-B 11/10/2026 | No se verificó ni ejecutó la migración en la base productiva; pueden existir registros legacy plaintext hasta aplicar el procedimiento controlado | Verificar `CHANNEL_CREDENTIALS_KEY` en API, backup, ejecutar dry-run, revisar reporte y ejecutar `--apply`; verificar resultado antes de retirar compatibilidad legacy | P0 |
| C-007 | INFRA | Gobierno seguro de backups con PII | 🔵 REQUIERE VALIDACIÓN EXTERNA | Existen copias locales y un reporte indica datos personales de leads; no se inspeccionó contenido | `backups/`; `docs/implementation/fase-0a-contencion-report.md:11-15` | Copias no cifradas, retención indefinida o acceso excesivo | Inventariar, cifrar, controlar acceso, definir retención y eliminación verificable | P0 |
| C-008 | ANDROID/EXTERNAL | Google Play Data Safety alineado al AAB actual | 🔵 REQUIERE VALIDACIÓN EXTERNA | Manifest solicita contactos/notificaciones y el propio comentario marca actualización Data Safety pendiente | `android/app/src/main/AndroidManifest.xml:52-68`; Play Console no accesible | Declaración inexacta y riesgo de suspensión | Comparar merged manifest, tráfico y SDKs con formulario publicado; actualizar evidencia | P0 |
| C-009 | LEGAL/DATABASE | Política de retención formal | 🔴 FALTA | La Privacy Policy es general; no existe schedule por categoría/finalidad/país | frontend `src/pages/legal/privacy.tsx:229-244`; modelos | Conservación excesiva | Aprobar matriz de retención y conectarla a jobs verificables | P1 |
| C-010 | DATABASE | TTL/archivo para payloads, conversaciones y RAG | 🟡 PARCIAL | Solo AutomationLog evidencia TTL de 90 días; registros principales no tienen TTL | `src/models/automation-log.model.js:47`; InboundEvent, OutboundEvent, Conversation, RAG | Acumulación de PII y contexto sensible | Definir TTL/archive según finalidad y legal hold | P1 |
| C-011 | DATABASE | Borrado real/cascade/anonymization | 🟡 PARCIAL | Leads y conversaciones usan soft delete; no hay cierre de tenant con cascade probado | modelos Lead, Conversation, User, Business | Datos activos después de solicitud | Orquestar cascade idempotente, borrar archivos/colas/cache y emitir evidencia | P1 |
| C-012 | LEGAL/BACKEND | Gestión DSAR: acceso, rectificación, oposición, portabilidad | 🔴 FALTA | No hay endpoints/casos/SLA; export administrativo de leads no equivale a DSAR | rutas de users/leads/reports | Derechos no operables ni auditables | Crear registro de solicitudes, verificación de identidad, export, resolución y SLA | P1 |
| C-013 | LEGAL | DPA y definición responsable/encargado | 🔴 FALTA | No se encontró DPA ni términos operativos B2B de tratamiento | repositorios/documentación | Roles y obligaciones contractuales ambiguos | Redactar DPA, anexos de seguridad e instrucciones de tratamiento | P1 |
| C-014 | LEGAL/EXTERNAL | Contratos y transferencias con subprocessors | 🔵 REQUIERE VALIDACIÓN EXTERNA | Integraciones técnicas identificadas; contratos/DPA/SCC no están en repositorio | OpenAI, Gupshup, Meta, Cloudinary/R2, Railway, Vercel, Firebase, Resend, pagos | Transferencias internacionales sin evidencia | Verificar DPA, región, SCC/medidas y mecanismo de cambios | P1 |
| C-015 | BACKEND | MFA para cuentas privilegiadas | 🔴 FALTA | No se detectó TOTP/WebAuthn/recovery codes | auth routes/services/models | Toma de cuentas administrativas | Añadir MFA obligatorio para owner/admin y step-up para acciones críticas | P1 |
| C-016 | BACKEND/FRONTEND | Gestión de sesiones y revocación global | 🟡 PARCIAL | Refresh JTI y rotación existen; no hay UI/listado de dispositivos, revoke-all persistente o lockout de cuenta | `src/services/auth.service.js:23-120`; auth UI | Persistencia de sesiones comprometidas | Registro de sesiones/dispositivos, revoke-all, alertas y lockout controlado | P1 |
| C-017 | BACKEND/DATABASE | Security/audit events inmutables | 🔴 FALTA | No se encontró modelo activo `security_events`/`audit_events`; logs no son trail inmutable | búsqueda en `src/models`, `src/services`, rutas admin | No repudio e investigación incompletos | Evento append-only para auth, admin, permisos, export, borrado, secretos e IA | P1 |
| C-018 | INFRA/LEGAL | Incident Response y notificación de brechas | 🔴 FALTA | No existe política/runbook formal con clasificación, responsables, evidencia y plazos | documentación | Respuesta tardía e incumplimiento de notificación | Crear IRP, playbooks, contactos, severidad, preservación y ejercicios | P1 |
| C-019 | INFRA | Backup/restore, RPO/RTO y DR probados | 🔵 REQUIERE VALIDACIÓN EXTERNA | No hay evidencia de schedule automatizado, restore test, RPO/RTO ni DR | documentación e infraestructura externa | Pérdida prolongada o irrecuperable | Documentar arquitectura, probar restauración no destructiva y registrar resultados | P1 |
| C-020 | BACKEND | Redacción de PII/secretos en logs | 🟡 PARCIAL | Error handler oculta stack en producción, pero gateway puede registrar payload raw y algunos imports valores/errores | `src/middleware/error.middleware.js:43-98`; `src/modules/channels/inbound.gateway.js:34`; imports | Exposición lateral y retención no controlada | Logger con redaction central, allowlist de campos y tests de no filtración | P1 |
| C-021 | IA/LEGAL | Política y disclosure de IA | 🔴 FALTA | No hay AI Policy/disclosure específico ni base de transparencia operacional | IA y páginas legales | Usuarios no conocen alcance/automatización | Política de IA, disclosure contextual, limitaciones y contacto humano | P1 |
| C-022 | IA/BACKEND | Autorización granular independiente del LLM | 🟡 PARCIAL | Tenant/resource checks existen, pero las tools declaran autorización `siempreAutorizada` | `src/tools/index.js:739-1021` | Acciones válidas para tenant pero excesivas para rol/contexto | Policy engine por tool, rol, canal, estado y confirmación | P1 |
| C-023 | IA/DATABASE | Audit trail persistente de acciones/modelos IA | 🟡 PARCIAL | Hay `AGENT_RUN` en logger y mensajes/tool calls, pero no registro inmutable con versión/modelo/aprobación | `src/services/ai.service.js:934-952` | Difícil explicar/revertir decisiones | Persistir AIAction con modelo, prompt version, inputs minimizados, tool/result y actor | P1 |
| C-024 | IA/SECURITY | Defensa sistemática contra prompt injection/exfiltración | 🟡 PARCIAL | Server-side tenant checks robustos; no hay framework/evals explícitos de instrucciones no confiables | `src/services/ai.service.js`, `src/tools/index.js` | Manipulación de tools o fuga contextual | Separar contenido no confiable, deny rules, evals adversariales y human approval | P1 |
| C-025 | BACKEND | Replay protection temporal de webhooks | 🟡 PARCIAL | Firmas e idempotencia existen; no se evidenció ventana de timestamp/nonce uniforme | `src/webhooks/webhook.service.js:27-70`; InboundEvent unique providerMessageId | Replays válidos fuera de idempotency key | Validar timestamp, tolerancia y nonce donde el proveedor lo soporte | P1 |
| C-026 | LEGAL/BACKEND | Country Compliance Engine | 🔴 FALTA | Existe `country`, pero no jurisdiction, rules, consent/retention/marketing regional | `src/models/business.model.js:175-184,309-313` | Reglas de un país aplicadas internacionalmente | Introducir catálogo de jurisdicción/versiones y resolución server-side | P1 |
| C-027 | FRONTEND | Minimización de contenido en almacenamiento local | 🟡 PARCIAL | Mensajes salientes optimistas se conservan en `localStorage` sin cifrado/TTL claro | `src/lib/api/conversations.ts:195-235` | Exposición en equipo compartido o XSS | TTL corto, purge tras sync/logout y almacenar solo metadatos imprescindibles | P2 |
| C-028 | FRONTEND/LEGAL | Gestión de cookies/preferencias | 🟡 PARCIAL | Existe Cookie Policy, no banner/centro de preferencias; no se detectó analytics activo | `src/pages/legal/cookies.tsx`; auth cookie | Incumplimiento si se agregan cookies no esenciales | Implementar CMP solo al activar categorías no esenciales y registrar elección | P2 |
| C-029 | LEGAL | Privacy Policy refleja tratamiento real | 🟡 PARCIAL | Política existe y está versionada visualmente, pero retención/proveedores/derechos no coinciden con controles backend | `src/pages/legal/privacy.tsx:229-244,317-339,407-414` | Transparencia materialmente incompleta | Mapear cada declaración a control/evidencia y actualizar texto | P2 |
| C-030 | LEGAL/BACKEND | Cambio de términos y reconsentimiento | 🔴 FALTA | No hay legal document registry ni aceptación por versión | auth/modelos legales | Cambios no demostrables | Registry de documentos, vigencia, reconsent y auditoría | P2 |
| C-031 | BACKEND/EXTERNAL | Lifecycle de tokens OAuth externos | 🟡 PARCIAL | Integraciones persisten tokens; rotación/expiración/revocación uniforme no demostrada | WebhookConfig e integraciones Meta/TikTok/Gupshup | Fallos y credenciales antiguas válidas | Normalizar vault, expiry, refresh, revoke y health | P2 |
| C-032 | LEGAL/EXTERNAL | Propagación de borrado a terceros | 🔴 FALTA | No hay orquestación documentada para OpenAI/storage/WhatsApp/email/push | workflows de eliminación ausentes | Datos permanecen en subprocessors | Catálogo de delete APIs, DPA y recibos por proveedor | P2 |
| C-033 | LEGAL | Registro de actividades y data-flow mantenido | 🟡 PARCIAL | Hay documentación técnica dispersa; no ROPA formal | `docs/**`; este informe inicia el mapa | Cambios de tratamiento sin control | Mantener ROPA propietario, base, finalidad, categoría, receptor y retención | P2 |
| C-034 | INFRA | SAST/SCA/secret scanning continuo | 🔴 FALTA | No se encontraron workflows CI/Dependabot ni pipeline de escaneo | ausencia de `.github/workflows` en ambos repos | CVEs/secretos llegan a main | CI protegido con audit/SCA/SAST/secret scan y reglas de severidad | P2 |
| C-035 | INFRA/LEGAL | SBOM versionado por release | 🔴 FALTA | No existe CycloneDX/SPDX | repositorios | Inventario y respuesta a CVE incompletos | Generar SBOM backend/frontend/AAB, firmar y archivar | P2 |
| C-036 | LEGAL | Revisión de licencias y notices | 🟡 PARCIAL | Inventario lockfile: MIT/Apache/ISC y componentes MPL/LGPL/UNKNOWN/SEE LICENSE | ambos `package-lock.json` | Obligaciones de notice/reciprocidad no gestionadas | Revisión legal, allowlist y THIRD_PARTY_NOTICES | P2 |
| C-037 | FRONTEND | Vulnerabilidades high/transitivas frontend | 🔴 FALTA | Tras C-005 y la remediación oficial de SheetJS, audit producción reporta 12: 0 critical, 11 high, 1 low; corresponden a Vite/Cloudflare y transitivas ajenas a xlsx | frontend lockfile | Supply-chain, build/runtime y DoS | Remediación mínima por árbol y separación dev/prod real | P2 |
| C-038 | INFRA | Programa de patching y SLA | 🔴 FALTA | No hay política de actualización, propietario ni SLA | documentación/CI | Vulnerabilidades envejecen | SLA critical/high, owner, excepción firmada y reporte mensual | P2 |
| C-039 | INFRA | APM/alertas de seguridad y privacidad | 🟡 PARCIAL | Healthchecks/logs existen; no se detectó APM/SIEM/alerting de eventos | health routes, logger | Incidentes silenciosos | Métricas, alertas, correlación, redacción y on-call | P2 |
| C-040 | BACKEND/LEGAL | Coherencia regional de defaults | 🟡 PARCIAL | País PE convive con timezone México y otros defaults; no hay resolución jurisdiccional | `src/models/business.model.js:175-184,309-313` | Fechas, retención y comunicaciones incorrectas | Defaults por país y migración explícita de tenants | P2 |
| C-041 | ANDROID | Matriz permiso-función-dato-evidencia | 🔵 REQUIERE VALIDACIÓN EXTERNA | Manifest fuente no prueba merged manifest ni declaración Play | Manifest, plugins Capacitor, AAB/Play externos | Sobredeclaración o permiso sin justificación | Generar matriz por release y validar merged manifest/tráfico | P2 |
| C-042 | LEGAL/SECURITY | Security Policy corporativa | 🔴 FALTA | No encontrada | documentación | Controles sin gobierno común | Política anual con roles, access control, crypto, SDLC y excepciones | P3 |
| C-043 | LEGAL | Acceptable Use Policy | 🔴 FALTA | No encontrada | documentación/legal frontend | Uso abusivo sin marco explícito | Definir actividades prohibidas, enforcement y apelación | P3 |
| C-044 | IA/LEGAL | Model cards y documentación operacional IA | 🔴 FALTA | No hay inventario formal de modelos, versiones, límites y evaluaciones | IA/docs | Cambios de modelo no gobernados | Model registry, cards, datasets/evals y aprobación de release | P3 |
| C-045 | INFRA | Business Continuity formal | 🔴 FALTA | No hay BCP probado | documentación | Continuidad dependiente de conocimiento tácito | BIA, proveedores críticos, alternativas y simulacros | P3 |
| C-046 | LEGAL/EXTERNAL | Vendor/subprocessor lifecycle register | 🟡 PARCIAL | Proveedores inferibles por código, no existe registro con owner/revisión/salida | dependencias/integraciones | Shadow processing y contratos caducos | Registro central, due diligence, renovación y offboarding | P3 |
| C-047 | FRONTEND | Cleanup de metadatos locales de integraciones | 🟡 PARCIAL | Estados/connection_info se guardan localmente por usuario | `src/components/**/IntegrationsSection.tsx:64-80` | Persistencia innecesaria de metadatos | Minimizar, TTL y purge en logout/desconexión | P3 |
| C-048 | INFRA | Reproducibilidad y claridad de deployment frontend | 🟡 PARCIAL | Vercel es real; configuración Wrangler histórica puede confundir y no hay CI declarativo | `.vercel/project.json`, `wrangler.*`, scripts package | Publicación equivocada o no reproducible | Documentar proveedor canónico y usar build/install reproducible en CI | P3 |

## 7. Frontend findings

- El consentimiento legal se presenta en UI, pero no llega al backend con versión y timestamp (C-001).
- La política de privacidad, términos y cookies existen, con versión visual `1.0.0` y fecha 15/07/2026, pero no están vinculados a evidencia individual ni a un registry (C-029, C-030).
- El access token se mantiene en memoria y se eliminan claves legacy; esto reduce exposición. La cookie de refresh es HttpOnly/Secure/SameSite=None/Partitioned.
- Los mensajes optimistas y ciertos metadatos de integración permanecen en localStorage sin lifecycle formal (C-027, C-047).
- No se detectó analytics activo; por tanto, una CMP no es bloqueante hoy, pero debe preceder cualquier cookie/SDK no esencial (C-028).

## 8. Backend findings

- La autenticación, tenant injection, RBAC, rate limiting y refresh rotation están implementados, pero faltan MFA, administración de sesiones y un audit trail inmutable.
- La persistencia registra grandes volúmenes de payload/mensajes sin retención general.
- Los tokens de `WebhookConfig` no usan el cifrado ya disponible para credenciales de canal.
- La auditoría de dependencias muestra una CVE crítica en el árbol de Express/proxy-addr, relevante porque la IP alimenta controles de seguridad.
- El error handler no expone stacks en producción; la política de redacción de logs aún no es uniforme.

## 9. Multi-tenant

**VERIFICADO POR AUDITORÍA PREVIA ✅**

- `auth.middleware.js`, `tenant.middleware.js` y `rbac.middleware.js` resuelven usuario fresco, membership, negocio activo y permisos server-side.
- `admin.controller.businessScope.test.js`, `tenant.middleware.test.js` y `ai.service.generateReply.tenantDefense.test.js` prueban aislamiento administrativo y de IA.
- `generateReply()` verifica que Conversation, Lead y Business pertenezcan al mismo tenant antes de OpenAI/tools/envío.
- Inbound/OutboundEvent incluyen business/channel/conversation e idempotency keys; los workers conservan el canal original.
- Cloudinary authenticated, storage documental y signed URLs incorporan contexto tenant.

No se encontró evidencia directa de una ruta cross-tenant abierta en el alcance revisado. Esto no sustituye tests continuos ni auditoría de nuevas rutas.

## 10. Security

### Controles correctos

- JWT y refresh JTI rotatorio en Redis; logout/revocación del token corriente.
- Rate limits específicos: login, registro y recuperación.
- CORS con allowlist HTTPS en producción.
- Helmet/CSP deny-all en la API.
- Webhooks con HMAC/token timing-safe y enrutamiento tenant/channel.
- Credenciales de WhatsApp channel cifradas con AES-256-GCM y HKDF por canal.
- Uploads con magic bytes, límites por tipo, authenticated assets y signed delivery.
- Release Android fail-closed para firma, `allowBackup=false`, minify/shrink y deep links acotados.

### Brechas

Prioridad inmediata: CVEs críticas, cifrado de tokens externos, MFA, security events, redacción de logs y replay freshness uniforme.

## 11. Privacy

La capa legal visual existe, pero el backend no ofrece una cadena probatoria completa. Falta registrar qué documento aceptó cada usuario, gestionar solicitudes, borrar o anonimizar en cascada, propagar eliminación a terceros y demostrar retención. La Privacy Policy afirma atención de eliminación vía soporte y un plazo, pero no existe workflow técnico auditable que garantice su ejecución.

## 12. WhatsApp

**VERIFICADO POR AUDITORÍA PREVIA ✅:** templates scoped al canal original, primer contacto template-first, ventana de 24 horas, OutboundEvent durable, BullMQ, retry, `delivery_uncertain`, receipts e idempotencia.

Brecha de compliance: no existe un ledger de opt-in con fuente/fecha/finalidad, ni suppression list o procesamiento normalizado de STOP/BAJA/SALIR. El hardening de entrega no sustituye el permiso legal para contactar.

## 13. AI Governance

| Función IA | Entrada/datos | Salida/acción | Controles | Riesgo residual |
|---|---|---|---|---|
| Generación de respuesta | Mensajes, lead, business, resumen, RAG | Texto y tool calls | Tenant invariant, tools server-side, handoff | Prompt injection, transparencia |
| Calificación | Conversación, presupuesto/timeline | Estado/score/atributos | Persistencia en conversación | Perfilado no divulgado |
| Product/RAG search | Catálogo, docs, chunks/embeddings | Evidencia comercial | Tenant-scoped queries, vector readiness | Retención y proveedor |
| Actualizar CRM | Lead/conversation context | Cambio de etapa/datos | Validaciones backend | Tool auth granular ausente |
| Enviar media/template | Asset/recipient/channel | OutboundEvent + worker | Canal original, signed URL, receipts | Base legal/opt-in |
| Human handoff | Señal IA/agente | Desactiva IA/notifica humano | Implementado | Audit trail formal ausente |

Proveedor/modelo: OpenAI, con modelo configurable por entorno. No se detectó entrenamiento propio con datos de clientes. Deben validarse contractualmente retención, región, uso para mejora y términos empresariales. Existe kill switch funcional por conversación/negocio y handoff humano, pero no una política corporativa, model registry ni action log inmutable.

## 14. Android / Google Play

- Package: `com.creaos.app`; `compileSdk`/`targetSdk` 36; `minSdk` 24; versión fuente revisada 1.5 (7).
- `allowBackup=false`, FileProvider no exportado y MainActivity exportada solo para launcher/deep links declarados.
- Release signing fail-closed, minify y shrink habilitados.
- No se detectó `server.url` productivo; se usa bundle local Capacitor.
- Permisos explícitos incluyen INTERNET, POST_NOTIFICATIONS y READ_CONTACTS; plugins abarcan camera, browser, contacts, push y otros.
- La correspondencia exacta con Data Safety, permisos merged del AAB y estado de Closed Testing requiere Play Console/AAB: **🔵 REQUIERE VALIDACIÓN EXTERNA**.
- La eliminación de cuenta exigida por Play no está implementada de extremo a extremo (C-002).

## 15. Open-source / SBOM

No existe SBOM ni pipeline continuo de SCA/SAST/secret scanning. La inspección de lockfiles muestra principalmente MIT, Apache-2.0, ISC y BSD; también aparecen MPL-2.0, LGPL-3.0-or-later, entradas `UNKNOWN`/`SEE LICENSE`. No se identificó GPL/AGPL directa en el inventario resumido, pero el resultado no reemplaza una revisión legal transitiva ni generación de notices.

Auditoría de producción y remediación P0-A:

- Backend antes: 17 vulnerabilidades (1 critical, 5 high, 11 moderate). Después: 1 (0 critical, 0 high, 1 moderate). `proxy-addr` quedó en 2.0.8 y `xlsx@0.18.5` fue retirado del árbol productivo en favor del tarball oficial, fijado e íntegro, de SheetJS CE 0.20.3. La MODERATE residual es `uuid@9.0.1`, cuya corrección automática exige cambio mayor.
- Frontend antes: 14 vulnerabilidades (1 critical, 12 high, 1 low). Después de C-005 y la remediación de SheetJS: 12 (0 critical, 11 high, 1 low). La critical de `@capacitor/android` quedó corregida en 8.5.1 y el HIGH de `xlsx@0.18.5` ya no está presente; los HIGH restantes se mantienen registrados en C-037.
- El audit original se ejecutó sin instalar ni modificar dependencias. La remediación P0-A posterior actualizó únicamente manifests/lockfiles relacionados y fue validada localmente sin push/deploy.

## 16. Retention / deletion

```text
CREATE  ✅ datos se crean con tenant y timestamps
USE     ✅ controles funcionales y tenant generalmente sólidos
STORE   🟡 cifrado/retención depende del tipo y proveedor
SHARE   🟡 múltiples subprocessors, contratos no verificados
ARCHIVE 🟡 logs y algún TTL; no hay schedule integral
DELETE  🔴 sin cierre de cuenta/cascade/third-party receipts
```

AutomationLog cuenta con TTL de 90 días y los logs locales rotan; la mayoría de datos CRM, mensajes, webhooks, RAG, pagos, push e imports no tienen expiración formal. Soft delete no equivale a eliminación de privacidad. Los assets poseen lifecycle técnico mejorado, pero no una política legal por tenant o jurisdicción.

## 17. Incident management

Healthchecks y logs ayudan a detectar indisponibilidad, pero no se encontró `security_events` implementado ni un procedimiento formal de incidentes/brechas. Falta clasificación, owner, on-call, preservación de evidencia, matriz de notificación, simulacros y postmortem. Los logs actuales no constituyen un audit trail inmutable.

## 18. International readiness

La arquitectura tiene `country`, idioma y timezone, pero no un motor normativo. La documentación legal revisada está orientada a Perú. Para Perú, México, Colombia, Chile, Argentina, resto de LATAM y España se necesita:

1. `jurisdiction` efectiva por tenant y, cuando aplique, por interesado.
2. `legal_document_version` y vigencia regional.
3. Reglas regionales de consentimiento, marketing y minoría de edad.
4. Retención, derechos y SLA por jurisdicción.
5. Catálogo de transferencias/subprocessors y localización.
6. Evidencia de opt-in por canal/finalidad.
7. Resolver país/timezone/currency desde una configuración explícita, no defaults incongruentes.

## 19. Existing controls already verified

| Control | Estado | Evidencia |
|---|---|---|
| Aislamiento administrativo multi-tenant | ✅ VERIFICADO POR AUDITORÍA PREVIA | tests de business scope/tenant middleware; commits P0/P1 |
| Invariantes Conversation/Lead/Business en IA | ✅ VERIFICADO POR AUDITORÍA PREVIA | `ai.service.generateReply.tenantDefense.test.js`; commit de tenant invariant |
| Webhooks fail-closed | ✅ VERIFICADO POR AUDITORÍA PREVIA | HMAC/token timing-safe, env validation, tests P0 |
| WhatsApp inbound/outbound durable | ✅ VERIFICADO POR AUDITORÍA PREVIA | InboundEvent/OutboundEvent, BullMQ, workers, receipts, delivery_uncertain |
| Mensajería manual/IA sin provider directo | ✅ VERIFICADO POR AUDITORÍA PREVIA | tests focalizados y commits durable outbound/media |
| Cloudinary privado/signed tenant-safe | ✅ VERIFICADO POR AUDITORÍA PREVIA | authenticated assets, migration legacy final 0, tests assets |
| RAG lifecycle y recuperación | ✅ VERIFICADO POR AUDITORÍA PREVIA | estados/versionado/predecessor/index readiness, tests RAG |
| Auth runtime | ✅ VERIFICADO POR AUDITORÍA PREVIA | refresh rotation, cookies seguras, CORS/CSP, rate limits |
| Notificaciones persistidas | ✅ VERIFICADO POR AUDITORÍA PREVIA | fuente backend, tenant isolation, FCM worker |
| Android hardening | ✅ VERIFICADO POR AUDITORÍA PREVIA | allowBackup false, deep links, local bundle, signing fail-closed, minify/shrink |

## 20. P0 — riesgo inmediato / lanzamiento

1. **C-001:** consentimiento legal no persistido ni versionado.
2. **C-002:** eliminación de cuenta/datos y URL pública operativa inexistentes.
3. **C-003:** WhatsApp sin ledger de opt-in/opt-out/suppression.
4. **C-004:** árbol backend con CVE crítica y cinco altas.
5. **C-005:** Capacitor Android 8.5.0 con CVE crítica corregida en 8.5.1.
6. **C-006:** access/verify tokens de WebhookConfig en texto claro.
7. **C-007:** backups con PII sin evidencia de cifrado, acceso, retención y eliminación.
8. **C-008:** Data Safety/permissions de la release requieren reconciliación inmediata en Play Console.

### Evidencia de remediación P0-A — C-004 y C-005 (11/10/2026)

#### C-004 — Backend

- **ANTES:** `npm audit --omit=dev`: 17 vulnerabilidades — 1 critical, 5 high, 11 moderate. La critical era `proxy-addr@2.0.7` (GHSA-jqcg-44mw-7w3h) a través de Express, con riesgo de spoofing por IPv4-mapped IPv6 en la confianza de proxy/IP.
- **DESPUÉS:** 1 vulnerabilidad — 0 critical, 0 high, 1 moderate.
- **PAQUETE RETIRADO / NUEVO:** se retiró `xlsx@0.18.5` del árbol productivo. Se fijó SheetJS CE oficial `0.20.3` desde `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, con integridad SHA-512 en ambos lockfiles y licencia Apache-2.0. Es la distribución oficial mantenida por SheetJS; conserva la API usada, Node/browser, lectura y escritura XLS/XLSX/CSV y libros con múltiples hojas.
- **VERSIONES:** Express 4.22.2 → 4.22.3; proxy-addr 2.0.7 → 2.0.8; multer 2.2.0 → 2.4.0; Joi 18.2.3 → 18.2.9; csv-parse 7.0.0 → 7.0.3; firebase-admin 14.3.0 → 14.5.0; @grpc/grpc-js 1.14.4 → 1.14.6; SheetJS CE 0.18.5 → 0.20.3. Transitivas compatibles: body-parser 1.20.8, qs 6.16.0, brace-expansion 2.1.7 y moment 2.31.0.
- **TESTS:** regresión original 16 suites/105 tests PASS; regresión de importadores 6 suites/78 tests PASS; contrato SheetJS backend 6/6 y frontend 7/7 PASS. Se cubrieron XLS, XLSX, CSV, primera hoja, UTF-8/español, vacíos, números, fechas, fórmulas cacheadas, 5000 filas dentro del límite, corrupción, columnas/filas inválidas y exportación de la plantilla de leads. TypeScript y build frontend PASS.
- **AUDIT RESULT:** backend critical 0, high 0, moderate 1, low 0; frontend critical 0, high 11, moderate 0, low 1. `xlsx` no aparece en ninguno de los reportes finales.
- **RIESGO RESIDUAL:** `uuid@9.0.1` conserva una MODERATE; npm propone un major y no se forzó. Los 11 HIGH/1 LOW frontend corresponden a C-037 y no a SheetJS/C-005. No queda HIGH/CRITICAL asociada al procesamiento XLS/XLSX/CSV.

#### C-005 — Frontend / Android

- **ANTES:** `@capacitor/android@8.5.0` vulnerable a GHSA-rvm3-566m-v7fv; audit: 1 critical, 12 high, 1 low.
- **DESPUÉS:** `@capacitor/android`, `@capacitor/core` y `@capacitor/cli` alineados exactamente en 8.5.1; audit: 0 critical, 12 high, 1 low.
- **VERSIONES:** 8.5.0 → 8.5.1, sin major upgrade.
- **TESTS:** frontend build PASS; 28 suites/180 tests PASS; Capacitor sync PASS con 8 plugins; Gradle 8.14.3/JDK 21; `bundleRelease` firmado PASS.
- **AUDIT RESULT:** critical 0; high 12; moderate 0; low 1. Las HIGH restantes son preexistentes y corresponden a C-037 (`vite`/tooling/Cloudflare transitivas, `xlsx`, etc.), no a C-005.
- **RIESGO RESIDUAL:** ninguno para GHSA-rvm3-566m-v7fv. Se preservaron package `com.creaos.app`, compile/target SDK 36, versión 1.5 (7), `allowBackup=false`, deep links, bundle local, plugins, firma fail-closed, minify y shrink.

### Evidencia de remediación P0-B — C-006 (11/10/2026)

- **ANTES:** `WebhookConfig.verifyToken` y `WebhookConfig.accessToken` se persistían como strings plaintext.
- **DESPUÉS:** ambos campos se cifran con AES-256-GCM y formato versionado v1, reutilizando la derivación HKDF existente con contexto aislado por id de registro y campo. `verifyToken` conserva solo un marcador SHA-256 no reversible para la consulta/indexación; `accessToken` no conserva plaintext.
- **COMPATIBILIDAD:** los registros legacy plaintext siguen siendo legibles temporalmente. Las nuevas creaciones y actualizaciones escriben exclusivamente ciphertext autenticado. Un ciphertext corrupto, una versión no soportada o un marcador sin ciphertext fallan cerrado.
- **SANITIZACIÓN:** los campos plaintext y cifrados usan `select:false`, se eliminan en `toJSON`/`toObject` y los endpoints administrativos solo exponen estado de configuración. La revisión de logs no encontró impresión de tokens, ciphertext, IV, auth tag ni clave maestra.
- **MIGRACIÓN:** `scripts/migrate-webhook-secrets.js` es dry-run por defecto y exige `--apply` para escribir. Cifra, verifica lo persistido y solo entonces retira plaintext; es idempotente y reporta exclusivamente proveedor, id, campo, estado y razón sanitizada.
- **TESTS:** 31 suites / 391 tests PASS en regresión focal y amplia de cifrado, webhooks, Meta, Gupshup, channels, inbound/outbound queues y workers, receipts, auth y aislamiento tenant.
- **RIESGO RESIDUAL:** no se inspeccionó ni migró la base productiva. Antes del despliegue debe verificarse `CHANNEL_CREDENTIALS_KEY` en la API, obtenerse un backup controlado, ejecutar el dry-run, revisar el reporte y autorizar expresamente `--apply`. Hasta completar esa operación, C-006 está cerrado en código pero no confirmado como migrado en producción.

## 21. P1 — antes de expansión internacional

C-009 a C-026: retención, cascade delete, DSAR, DPA, subprocessors/transferencias, MFA, sesiones, security events, incident response, DR, redacción, AI governance, tool authorization, AI audit, prompt injection, replay protection y Country Compliance Engine.

## 22. P2 — primeros 90 días

C-027 a C-041: almacenamiento local, preferencias de cookies, alineación de políticas, reconsentimiento, OAuth lifecycle, borrado en terceros, ROPA/data map, CI security, SBOM, licencias, CVEs frontend, patch SLA, monitorización, defaults regionales y matriz Android Data Safety.

## 23. P3 — 6 a 12 meses

C-042 a C-048: Security Policy, AUP, model cards, Business Continuity, vendor lifecycle, cleanup de metadatos locales y deployment frontend reproducible/canónico.

## 24. External / manual actions

Estas comprobaciones no pueden inferirse del repositorio y deben marcarse **🔵 REQUIERE VALIDACIÓN EXTERNA**:

- Play Console: Data Safety publicada, permisos del AAB, URL de eliminación y versión activa.
- Meta Business/Gupshup: opt-ins, templates, configuración real, retención y contratos.
- OpenAI y demás proveedores: DPA, región, retención, entrenamiento/mejora y borrado.
- Railway/Vercel/MongoDB/Redis/Cloudinary/R2/Firebase/Resend/pagos: cifrado en reposo, región, backups, access logs, DPA y subprocesadores.
- Backups reales: inventario, cifrado, ACL, retención, restore test y eliminación.
- Autoridad/registro gubernamental aplicable, representante y obligaciones por país.
- Contratos corporativos, DPA con clientes, SCC/transferencias y políticas aprobadas.
- Estado real de MFA/SSO y controles de acceso en consolas cloud.

## 25. Recommended implementation order

1. Congelar evidencia de alcance y asignar owners de Privacy, Security, Android y WhatsApp.
2. Remediar C-004/C-005 y publicar releases verificadas.
3. Cifrar/rotar credenciales C-006.
4. Implementar registro versionado de consentimiento C-001.
5. Implementar opt-in/opt-out/suppression y enforcement C-003.
6. Implementar eliminación/DSAR/cascade/third-party receipts C-002/C-011/C-012/C-032.
7. Auditar y gobernar backups; probar restore y aprobar RPO/RTO C-007/C-019.
8. Reconciliar Play Data Safety, permisos y account deletion C-008/C-041.
9. Aprobar retention schedule y automatizar lifecycle C-009/C-010.
10. Establecer security/audit events, redacción y incident response C-017/C-018/C-020.
11. Añadir MFA y administración de sesiones C-015/C-016.
12. Formalizar DPA, subprocessors, transferencias y ROPA C-013/C-014/C-033/C-046.
13. Crear AI governance, tool policy, registry y evals C-021 a C-024/C-044.
14. Crear Country Compliance Engine C-026/C-040 antes de activar nuevos países.
15. Implantar CI security, SBOM, licencias, patching y observabilidad C-034 a C-039.
16. Completar políticas corporativas, BCP y hygiene frontend C-027/C-028/C-042/C-043/C-045/C-047/C-048.

---

### Limitaciones y declaración de integridad

Este informe se basa exclusivamente en evidencia estática de los dos repositorios autorizados, documentación existente, historial Git y auditoría read-only de lockfiles. No se asumió cumplimiento de controles alojados en consolas externas. No se inspeccionaron secretos, datos productivos ni el contenido de backups. No se modificó código, configuración, dependencias, variables, ramas, commits, despliegues ni producción. El único archivo creado por esta auditoría es este documento.
