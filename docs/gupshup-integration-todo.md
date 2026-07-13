# Webhook de Gupshup — verificación pendiente de credencial

A diferencia de Stripe/MercadoPago/Meta (que firman con HMAC), Gupshup no ofrece
HMAC ni Basic Auth tradicional en su panel de webhooks — solo permite configurar
un **header HTTP personalizado libre** (nombre + valor) que reenvía en cada
request entrante.

## 1. Estado actual

- **Webhook receiver**: implementado en `src/modules/webhooks/webhook.controller.js` → `gupshupWebhook`.
- **Verificación**: `verifyGupshupAuth` (`src/modules/webhooks/webhook.service.js`) compara el header
  `X-Gupshup-Webhook-Token` contra `GUPSHUP_WEBHOOK_TOKEN` con `crypto.timingSafeEqual`, siguiendo el
  mismo patrón fail-closed usado en Stripe/MercadoPago/Meta/TikTok/WhatsApp:
  fuera de producción se permite el bypass solo si `GUPSHUP_WEBHOOK_TOKEN` no está configurado; en
  producción, si falta el token o no coincide, se rechaza con `401`.
- **`GUPSHUP_WEBHOOK_TOKEN` aún no existe en Railway** (entorno `production`, servicio `creaos-backend`)
  → el webhook rechaza todo con `401` hasta que se configure. No hay riesgo de seguridad activo.

## 2. Endpoint del webhook

```
POST https://creaos-backend-production.up.railway.app/api/v1/webhooks/gupshup
```

## 3. Checklist para activarlo

- [ ] En el panel de Gupshup (tu app → Webhook config → Custom Header), definir:
      - Nombre del header: `X-Gupshup-Webhook-Token`
      - Valor: un secreto generado (ej. `openssl rand -hex 32`)
- [ ] Configurar el mismo valor en Railway:
  ```bash
  echo "EL_MISMO_VALOR" | railway variable set GUPSHUP_WEBHOOK_TOKEN --stdin --service creaos-backend --environment production
  ```
- [ ] Verificar con `railway variables` que quedó configurado
- [ ] Prueba end-to-end: request sin header o con valor incorrecto → `401`; con el valor correcto → `200`
      (mismo patrón usado para Stripe/MercadoPago)

## 4. Referencia cruzada

Mismo patrón de seguridad (`NODE_ENV`-gated + fail-closed en producción) aplicado también en Stripe,
MercadoPago, Meta, WhatsApp y TikTok (ver [`docs/tiktok-integration-todo.md`](./tiktok-integration-todo.md)).
