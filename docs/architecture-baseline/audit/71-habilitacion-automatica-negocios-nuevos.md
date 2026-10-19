# 71 — Habilitación automática del modo enlace único para negocios nuevos

19-oct-2026. Rama `feat/enlace-unico-negocios-nuevos` (desde `origin/main` `0884ead`). Sin push, merge ni deploy; sin variables activadas en Railway; sin números reales ni llamadas a Gupshup (todo simulado).

## Qué faltaba
Con el código del PR #124 el modo solo podía activarse **para todos o para una lista manual de `tenantId`**:
- `ONBOARDING_LINK_MODE_ENABLED=true` + lista vacía = **todos los negocios**, incluidos CREA OS y NUTRIVA (que deben conservar su flujo y sus canales).
- La única forma de limitarlo era escribir un `tenantId` por cliente (lo que se quiere evitar).
El flujo de registro, en cambio, ya estaba bien: el registro real crea el negocio y su dueño (rol Owner, con `businesses:settings`), el negocio nace en el plan Starter (WhatsApp incluido) y el negocio **sale siempre del token**, nunca del cuerpo de la solicitud.

## Qué se corrigió (cambio mínimo: 3 archivos de código)
Reglas de `modoEnlaceHabilitado(tenantId)` (ahora asíncrona):
1. `ONBOARDING_LINK_MODE_ENABLED` ≠ `true` → **nadie** usa el modo (interruptor global y de emergencia; ni nuevos ni de la lista).
2. Negocio en `ONBOARDING_LINK_MODE_TENANTS` → sí (excepción explícita, p. ej. un negocio de prueba). **Una lista vacía ya no significa «todos».**
3. Negocio con fecha de registro ≥ `ONBOARDING_LINK_MODE_NEW_TENANTS_FROM` (ISO, p. ej. `2026-10-20T00:00:00Z`) → sí, **automáticamente**. Fecha vacía o inválida → ningún negocio por antigüedad (falla cerrado).
4. Cualquier otro (negocios existentes) → flujo clásico.
Archivos: `config/env.js` (variable nueva), `channelOnboardingLink.service.js` (reglas), `channel.controller.js` (`await`). La fecha se lee del negocio del token en la base de datos.

Con el interruptor apagado el comportamiento es idéntico al anterior. Una conexión **ya iniciada** en modo enlace se completa igual aunque se apague el interruptor (webhook y barrido no dependen de él); solo se bloquean los inicios nuevos (`/start` → 404, `/mode` → clásico).

## Pruebas (simuladas; base de datos de prueba propia; sin números reales)
- **`channel.linkMode.newTenants.e2e.test.js` (10 pruebas):** usan el **registro real** (`auth.service#registrar`), los middlewares reales de permisos y de capacidad, y el plan Starter como en el seed.
  - Negocio nuevo, sin lista: modo automático, permisos y plan correctos, conexión de punta a punta hasta canal activo con el estado real de Gupshup, sin pasos administrativos; un `tenantId` ajeno en el cuerpo se ignora.
  - Negocio existente (fecha anterior, fuera de la lista): flujo clásico, `/start` 404, cero llamadas a Gupshup.
  - Lista explícita: habilita solo al negocio indicado.
  - Interruptor global apagado: ni nuevos ni de la lista; la conexión ya iniciada se completa.
  - Fecha vacía/inválida: falla cerrado (4 valores) y fecha válida se interpreta bien.
  - Aislamiento entre dos negocios nuevos: sesiones y apps separadas, no se puede conciliar la sesión ajena, el número ya activado en uno da `identity_conflict` en el otro.
  - Errores de Gupshup: fallo al crear la app (sin canal, estado «reintentar», reintento = una sola app), fallo tras crearla (el reintento reutiliza la misma app), 5xx al consultar el estado (no activa nada, se reintenta), app no activa o con datos incompletos (nunca activa).
- Sensibilidad verificada con mutaciones: «fecha vacía habilita a todos» y «sin interruptor global» son detectadas por las pruebas.
- Las pruebas del PR #124 se ajustaron a la nueva regla (la lista vacía ya no habilita a todos).

## Qué falta para iniciar una prueba real como cliente nuevo
1. Autorizar push/PR/merge/deploy de esta rama (con las variables sin definir, el comportamiento no cambia) **y** el despliegue del frontend `feat/onboarding-enlace-unico` (`8e2f4d6`, aún sin fusionar).
2. Activación (la hace quien tenga el acceso a Railway, solo en la **API**): `ONBOARDING_LINK_MODE_ENABLED=true` y `ONBOARDING_LINK_MODE_NEW_TENANTS_FROM=<momento de la activación en ISO>`. Para probar con un negocio concreto anterior a esa fecha, añadir su id a `ONBOARDING_LINK_MODE_TENANTS`.
3. Un negocio nuevo registrado en creaosapp.com **después** de esa fecha y un número que su titular pueda autorizar y que no esté en ninguna WABA/app.
4. Criterios PASS/FAIL del informe 70.
5. Parada de emergencia: `ONBOARDING_LINK_MODE_ENABLED=false` (o quitar la variable) y redeploy de la API.
Pendientes conocidos (no resueltos aquí): hipótesis de Gupshup sin probar con una alta real (llegar a Live con un solo enlace, línea de crédito y Solution ID automáticos), confirmación escrita de la deprecación del 31-oct, y el evento `docker-status-event` (hoy el respaldo es el barrido de 30 min y «Ya terminé»).
