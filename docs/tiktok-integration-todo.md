# Integración de TikTok Ads — pausada hasta v1.2

## 1. Estado actual

- **Webhook receiver**: implementado en Sprint 5 (`src/modules/webhooks/webhook.controller.js` → `tiktokWebhook`, `tiktokVerify`).
- **Verificación de firma**: `verifyTikTokSignature` (`src/modules/webhooks/webhook.service.js`) fue corregida para ser *fail-closed* — el bypass por secret ausente solo aplica fuera de producción (`NODE_ENV !== 'production'`). En producción, si falta `TIKTOK_APP_SECRET`, la verificación **rechaza** en vez de aceptar sin firma.
- **`TIKTOK_APP_SECRET` aún no existe en Railway** (entorno `production`, servicio `creaos-backend`) — confirmado por `railway variables`.
- **No hay riesgo de seguridad activo**: mientras falte el secret, el webhook responde `401 { "error": "Invalid signature" }` a cualquier request, firmada o no. No hay ventana de aceptación de datos falsificados.

## 2. Endpoint del webhook

Confirmado en `src/modules/webhooks/webhook.routes.js:14-15`, montado bajo el prefijo `/api/v1/webhooks` (`src/app.js:115`):

```
POST https://creaos-backend-production.up.railway.app/api/v1/webhooks/tiktok
GET  https://creaos-backend-production.up.railway.app/api/v1/webhooks/tiktok   (challenge de verificación, usa ?verify_token=)
```

Esta es la URL exacta para pegar en el panel de TikTok for Business cuando se cree la app.

## 3. Checklist de pasos pendientes para retomar en v1.2

- [ ] Crear app en TikTok for Business Developers
- [ ] Obtener App ID y App Secret
- [ ] Configurar la URL del webhook en el panel de TikTok (usar la ruta confirmada en el punto 2)
- [ ] Correr:
  ```bash
  echo "SECRET" | railway variable set TIKTOK_APP_SECRET --stdin --service creaos-backend --environment production
  ```
- [ ] Verificar con `railway variables` que quedó configurado
- [ ] Hacer prueba end-to-end (firma forjada → `401`, firma real → `200`), igual que se hizo con Stripe/MercadoPago
- [ ] Revisar si el frontend (Lovable) necesita una pantalla "Conectar TikTok Ads" similar a la de Meta OAuth, o si eso también se deja para v1.2

## 4. Referencia cruzada

El mismo patrón de seguridad (`NODE_ENV`-gated + fail-closed en producción) ya se aplicó también en:

- **Stripe** (`subscription.service.js` → `handleStripeWebhook`)
- **MercadoPago** (`subscription.service.js` → `verifyMercadoPagoSignature`)
- **Meta** (`webhook.service.js` → `verifyMetaSignature`)
- **WhatsApp** (`webhook.service.js` → `verifyMetaSignature`, reutilizada con `WHATSAPP_APP_SECRET` / fallback a `META_APP_SECRET`)
