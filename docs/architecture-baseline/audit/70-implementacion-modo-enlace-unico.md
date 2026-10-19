# 70 — Implementación del «modo enlace único» (entregable): ramas, archivos, pruebas, riesgos y procedimiento de prueba real

19-oct-2026. Ramas aisladas **sin commit, push, merge ni deploy**: backend `feat/onboarding-enlace-unico` (desde `origin/main` `9eafaab`) y frontend `feat/onboarding-enlace-unico` (desde `origin/main` `3f1f548`, que ya incluye el sondeo único). No se crearon apps ni números reales, no se tocaron producción, Railway, Redis, credenciales, bases de datos ni las conexiones de CREA OS, NUTRIVA y LOTEXIA. Nuevo flujo **desactivado por defecto**.

## Qué hace
El cliente pulsa **«Conectar WhatsApp»**, escribe su número (con código de país) y se abre **una sola ventana de autorización: el enlace firmado de Gupshup** (proveedor oficial; el texto de la pantalla lo dice con claridad). Sin ventana previa de Meta de CREA OS, sin portal de Gupshup, sin segunda ventana nuestra. Detrás: `POST /embedded-signup/start` crea (o retoma) la sesión, crea/reutiliza la app (`POST /partner/app`), suscribe los dos callbacks, fija el contacto y genera el enlace (`GET onboarding/embed/link`), todo con el **Partner JWT existente** (nada de Bizgate, Universal Tokens, `tpp/app` ni vinculación por App ID + API key). La activación sigue siendo la existente (webhook `ACCOUNT_VERIFIED` + conciliación/barrido cada 30 min + «Ya terminé») y **solo activa un canal si Gupshup confirma que la app está Live con el MISMO número que declaró el cliente**.
Si Gupshup exigiera otra autorización, la pantalla no la oculta: la prueba real (sección 5) lo detecta como FAIL.

## Interruptor (apagado por defecto)
- `ONBOARDING_LINK_MODE_ENABLED` (solo `true` lo activa) y `ONBOARDING_LINK_MODE_TENANTS` (ids de negocio separados por coma; vacío = todos cuando está activo). Se leen **solo en la API**.
- Apagado: `GET /embedded-signup/mode` → `meta_then_link`; `POST /embedded-signup/start` → **404** sin crear nada ni llamar a Gupshup; el frontend muestra el botón y el flujo de siempre.

## Archivos
**Backend (8 modificados, 3 nuevos)**
| Archivo | Cambio |
|---|---|
| `src/config/env.js` | 2 variables del interruptor |
| `channelOnboardingSession.model.js` | campos `mode` (opcional), `declaredPhone`, `startLeaseUntil` (sin índices nuevos) |
| `channelOnboardingApp.service.js` | `telefonoEsperado()` / `esModoEnlace()` (número de Meta **o** el declarado) usados en las evaluaciones de seguridad de la app |
| `channelOnboardingCompletion.service.js` | guardas de identidad contra `telefonoEsperado()` (sesiones clásicas: idéntico) |
| `channelOnboardingReconcileSweep.service.js` | el barrido también toma sesiones del modo enlace (`mode:'gupshup_link'` + `declaredPhone`) |
| `channelOnboardingStatus.service.js` (+ su test) | estado informa `mode`; base de la conexión = número declarado |
| `channel.controller.js`, `channel.routes.js` | `GET /mode` y `POST /start` (mismos permisos y capacidad que el resto) |
| **`channelOnboardingLink.service.js`** (nuevo) | orquestación idempotente |
| **`channelOnboardingLink.service.test.js`** (nuevo, 34 pruebas) y **`channel.linkMode.e2e.test.js`** (nuevo, 5) | pruebas con Gupshup simulado |

**Frontend (7 modificados, 2 nuevos)**: `api/whatsapp-embedded-signup.ts` (`getOnboardingMode`, `startLinkOnboarding`), `use-whatsapp-connect.ts` (`linkMode`, `startLink`, modo en caché), `whatsapp-onboarding-state.ts` (textos del modo y `parseDeclaredPhone`), `IntegrationsSection.tsx` (formulario si `linkMode`), **`WhatsappLinkConnectForm.tsx`** (nuevo), **`use-whatsapp-connect.linkMode.test.ts`** (nuevo, 14) y las pruebas existentes ampliadas.

## Garantías implementadas
- **Multi-tenant:** toda consulta acotada por `tenantId`; apps de otro negocio nunca se reutilizan; un número de otro negocio responde 409 genérico sin revelar de quién; `identity_conflict` y `mismatch` intactos.
- **Sin duplicados:** misma solicitud (negocio + número) = misma sesión, app y enlace. La unicidad la da la base de datos mediante el `state` único derivado del intento (sin índices nuevos); un arrendamiento atómico evita que dos solicitudes simultáneas ejecuten los pasos de Gupshup a la vez; la app se guarda antes de seguir; el 409 «Bot Already Exists» se resuelve por nombre. (Una primera versión con «gana la más antigua» falló una prueba de concurrencia y se reemplazó; 20 solicitudes simultáneas ya dejan 1 sesión y 1 app.)
- **Recuperación:** fallos de Gupshup dejan la sesión `failed` (paso `gupshup_registration`) con el arrendamiento liberado y **«Reintentar» repite /start con el mismo número**; enlace casi vencido o vencido se regenera sin crear otra app; sesión vencida → intento siguiente reutiliza la app segura.
- **Sin credenciales en el navegador:** el frontend nunca recibe el JWT, apikeys ni secretos; solo el enlace firmado de su propia conexión.
- **Flujo clásico intacto:** pruebas de que una sesión clásica sigue conciliando contra el número de Meta y de que `init → code → callback → complete-gupshup` sigue funcionando con el modo activo en el entorno.

## Resultados de pruebas (ejecutadas hoy)
| | Resultado |
|---|---|
| Backend, suite completa | **Incidencia registrada, no ocultada:** en una ejecución completa (216/217 suites) fallaron 2 pruebas de `src/modules/ai/ai.service.manualOutbound.test.js` («template manual usa el mismo OutboundEvent durable» y «template MARKETING sin consentimiento no crea mensaje ni OutboundEvent») con la suite completa bajo carga (~34 s la suite). Aisladas pasan 16/16 en dos ejecuciones y ya habían pasado en la ejecución completa anterior; el archivo no se tocó y no usa nada de lo modificado. Se considera inestabilidad de tiempos bajo carga, **no demostrada como ajena de forma concluyente**; el resultado de la ejecución completa final está en la sección «Comprobaciones finales» |
| Backend, módulo nuevo | 34 pruebas del servicio + 5 e2e, estables en 3 ejecuciones |
| Frontend, suite completa | 64 archivos, **733** pruebas verdes · `tsc --noEmit` sin errores · `vite build` correcto · ESLint semántico limpio |
| Cobertura de lo pedido | error de Gupshup (500/502/400/429), solicitudes repetidas y simultáneas, conexión pendiente, activación por conciliación, barrido y webhook (con reentrega), número distinto, número de otro negocio, enlace vencido, aislamiento, interruptor apagado/por negocio |

## Riesgos pendientes
1. **Hipótesis central sin probar con Gupshup real:** que completar solo el enlace de un número «limpio» lleve la app a Live y adjunte línea de crédito y Solution ID sin otro paso (V5/V6/V7 del informe 68). Solo la prueba real lo demuestra.
2. **Deprecación del 31-oct:** según lo publicado no afecta a estas llamadas; sigue pendiente la confirmación escrita (informe 69).
3. **Evento Live:** se reutiliza `ACCOUNT_VERIFIED`; el formato `onboarding-event/docker-status-event` no se maneja (respaldo: barrido cada 30 min y «Ya terminé»).
4. **El cliente puede elegir otro número en la ventana de Gupshup** → `mismatch` (no se activa nada; la pantalla lo explica y pide empezar de nuevo). No se puede impedir desde nuestro lado.
5. La lógica de suscripciones está duplicada respecto de `channel.controller.js` (a propósito, para no tocar el flujo que funciona); unificarla es tarea posterior.
6. Cada usuario que abre Conexiones hace una consulta extra `GET /mode` (cacheada 5 min); con un backend sin la ruta (despliegue en cualquier orden) el frontend asume el flujo clásico.
7. Mientras se despliega con el interruptor apagado, **no hay cambio visible** para los usuarios.

## Procedimiento para probar con un negocio completamente nuevo (autorización separada)
**Precondiciones (tuyas):** autorizar merge/deploy de ambas ramas **con el interruptor apagado**; un negocio de prueba creado desde cero en CREA OS (no CREA OS, NUTRIVA ni LOTEXIA); un número que su titular pueda autorizar y que **no** esté registrado en ninguna WABA/app (ni en una ventana previa de CREA OS/Gupshup); el id del negocio de prueba.
1. **Foto previa (solo lectura):** conteo de sesiones/apps/canales del negocio de prueba y huella de los canales de CREA OS y NUTRIVA.
2. **Activar para ese negocio únicamente:** en la API, `ONBOARDING_LINK_MODE_ENABLED=true` y `ONBOARDING_LINK_MODE_TENANTS=<id del negocio de prueba>` (con la lista, los demás negocios siguen en `meta_then_link`).
3. **Ejecutar una vez:** el titular entra, Mi negocio → Conexiones → escribe el número → «Conectar WhatsApp» → completa la ventana de Gupshup con Facebook y ese número → vuelve a CREA OS (o pulsa «Ya terminé»). Sin tocar el portal de Gupshup.
4. **Parada inmediata** si aparece el error #2494156, una segunda ventana/autorización, `mismatch` o `identity_conflict` inesperado; no se reintenta ni se borra nada.
5. **Verificar (solo lectura):**
| Criterio | PASS | FAIL |
|---|---|---|
| Autorizaciones | 1 sola (la del enlace) | 2 o error de Meta |
| App de Gupshup | 1, con teléfono y WABA, `live:true` | vacía o duplicada |
| Sesión | `completed` (webhook o conciliación) en < 30 min tras completar la ventana | pendiente sin causa |
| Canal | 1 `DEDICATED` activo con el número declarado + 1 credencial | número distinto, 0 o >1 |
| Mensajería | 1 mensaje entrante y 1 saliente de prueba correctos | cualquiera falla |
| Idempotencia | «Conectar»/«Ya terminé» repetidos no crean nada nuevo | cualquier duplicado |
| Aislamiento | huellas de CREA OS y NUTRIVA idénticas; sin 429 del limitador | cualquier cambio |
| Facturación | consumo trazable a la billetera 334449 (confirmar con Gupshup) | sin cargo trazable |
6. **Rollback:** quitar las dos variables (o `ONBOARDING_LINK_MODE_ENABLED=false`) y redeploy de la API; la sesión de prueba queda en el historial sin afectar a nadie; no se borra nada en Gupshup. Un revert de los dos merges devuelve el estado anterior (los campos nuevos del modelo son opcionales).

---

## Comprobaciones finales (19-oct-2026, antes del commit local)
- **Suite completa del backend, ejecución final: 217 suites / 2316 pruebas, todas verdes** (sin incidencias en esta ejecución). La ejecución completa anterior tuvo la incidencia de tiempo agotado descrita arriba (2 pruebas de `ai.service.manualOutbound`); **no se puede afirmar que la suite haya pasado siempre sin incidencias**: hay una prueba sensible a la carga que conviene vigilar en CI.
- **Frontend:** 64 archivos / 733 pruebas verdes, `tsc --noEmit` sin errores, `vite build` correcto (solo avisos previos de «use client» de dependencias).
- **Interruptor apagado por defecto:** `ONBOARDING_LINK_MODE_ENABLED: process.env.ONBOARDING_LINK_MODE_ENABLED === 'true'` (solo el texto exacto `true` lo activa) y una prueba lo comprueba; en Railway (API y worker) **no existe ninguna variable `ONBOARDING_LINK_*`**; el despliegue en producción sigue siendo el anterior (API `a46dd216`).
- **Seguridad:** escaneo de las líneas añadidas en ambos repositorios sin secretos, tokens ni patrones de inyección; el navegador no recibe credenciales (solo el enlace firmado de su propia conexión); el nuevo endpoint exige los mismos permisos y capacidad que el resto del autoservicio; el número se valida en frontend y backend.
- **CREA OS, NUTRIVA y LOTEXIA (lectura de solo lectura en producción):** ningún cambio atribuible a este trabajo, porque nada se desplegó. Estado observado: CREA OS `DEDICATED`/`partner` activo; NUTRIVA activo (más un canal anterior desconectado y el canal `PLATFORM` de CREA OS suspendido, como antes); sesión de LOTEXIA clásica (sin campo `mode`), `gupshup_registering`, 51 intentos de conciliación `pending`, vence el 23-oct. Hay **0** sesiones con el campo `mode` en producción. Los `updatedAt` recientes de los canales activos corresponden a su actividad normal.
