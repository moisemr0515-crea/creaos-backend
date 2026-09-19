require('dotenv').config();

// Forzar Google DNS antes de cualquier conexión (el router bloquea consultas SRV
// que usa mongodb+srv://) — mismo fix que ya tienen server.js y roles.seed.js;
// a este seed se le había quedado afuera, y por eso corría bien contra un
// MONGODB_URI local (mongodb://, sin SRV) pero fallaba con
// "querySrv ECONNREFUSED" contra Atlas en producción (mongodb+srv://).
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const Plan     = require('../../modules/subscriptions/plan.model');
const { MONGODB_URI, STRIPE_SECRET_KEY } = require('../../config/env');

const PLANS = [
  {
    name:        'starter',
    displayName: 'Starter',
    price:       0,
    price_ars:   0,
    currency:    'USD',
    interval:    'month',
    // Fase 3 del diagnóstico "desincronización de plan Starter" (19/sep/2026):
    // reemplazo COMPLETO, no un parche de 1-2 líneas. Antes este array era
    // copy de marketing genérico, DESACOPLADO de `limits` de abajo — por eso
    // "WhatsApp integrado"/"IA básica asistida" podían aparecer en pantalla
    // mientras `limits.whatsappEnabled`/`aiEnabled` seguían en `false` en
    // producción (ver diagnóstico). A partir de este PR, `features` es la
    // ÚNICA fuente que consume el frontend (plan.tsx ya no tiene su propio
    // array local) — cada línea acá tiene que reflejar de verdad lo que
    // `limits` habilita, en el mismo orden en que se muestra al usuario.
    // "Embudo de ventas"/"Dashboard básico" quedan eliminados del todo (no
    // se movieron a otro plan) — decisión de producto confirmada, no un
    // olvido. "Seguimiento automático"/"Cierre asistido por IA" quedan
    // EXCLUSIVOS de Closer/Dominator a propósito — ver sus bloques abajo.
    features:    [
      'Gestiona hasta 20 oportunidades de venta activas',
      'CRM Inteligente',
      'WhatsApp Business integrado',
      'IA automática 24/7',
      'Hasta 20 automatizaciones inteligentes',
      'Dashboard de ventas',
      'Estadísticas comerciales',
      'Roles y permisos',
      'Soporte por documentación y comunidad',
    ],
    limits: {
      // Track 2, segunda vuelta (sesión de sincronización /plan del
      // 11/sep/2026): se sube de 10 a 20, mismo criterio que
      // closer/dominator más abajo — el copy pasa a "Gestiona hasta 20
      // oportunidades de venta activas", nunca se baja, así que ningún
      // negocio Starter existente puede quedar sobre el límite por esto.
      leadsPerMonth:      20,
      // aiEnabled/whatsappEnabled ya estaban en `true` acá desde cda4e16
      // (13/sep/2026) — el bug real (ver diagnóstico) era que ese fix nunca
      // se había vuelto a correr contra producción. automationsEnabled/
      // maxActiveAutomations SÍ son un cambio de valor real de este PR (antes
      // false/0): decisión de producto confirmada 19/sep — Starter pasa a
      // tener automatizaciones, con el mismo tope (20) que sus leads/mes.
      aiEnabled:          true,
      automationsEnabled: true,
      maxActiveAutomations: 20,
      whatsappEnabled:    true,
      multiUser:          false,
      maxUsers:           1,
      advancedReports:    false,
    },
    isActive: true,
  },
  {
    name:        'closer',
    displayName: 'Closer',
    price:       29,
    price_ars:   29000,
    currency:    'USD',
    interval:    'month',
    // Fase 3 (19/sep/2026) — mismo criterio que 'starter' arriba: lista
    // completa, única fuente real que consume el frontend. Simétrica a
    // Starter salvo los topes numéricos y las 2 features exclusivas de
    // Closer/Dominator (seguimiento automático, cierre asistido por IA) —
    // "Webhooks Meta & TikTok" queda retirado del copy (no es un
    // diferenciador de plan real, no tiene un `limits.*` propio que lo
    // respalde) para no reintroducir la misma desincronización copy-vs-
    // entitlement que originó este diagnóstico.
    features:    [
      'Gestiona hasta 300 oportunidades de venta activas',
      'CRM Inteligente',
      'WhatsApp Business integrado',
      'IA automática 24/7',
      'Hasta 100 automatizaciones inteligentes',
      'Seguimiento automático',
      'Cierre asistido por IA',
      'Dashboard de ventas',
      'Estadísticas comerciales',
      'Roles y permisos',
      'Soporte prioritario',
    ],
    limits: {
      // Track 2 (sesión de sincronización /plan del 11/sep/2026): el copy
      // de plan.tsx ("Gestiona hasta 300 oportunidades de venta activas")
      // era el correcto — este seed estaba desactualizado (100), no al
      // revés. Se sube el tope real para que coincida con lo que el
      // producto ya promete públicamente; nunca se baja, así que ningún
      // negocio existente puede quedar "sobre el límite" por este cambio
      // (mismo criterio ya usado para maxUsers más abajo).
      leadsPerMonth:      300,
      aiEnabled:          true,
      automationsEnabled: true,
      maxActiveAutomations: 100,
      whatsappEnabled:    true,
      // La oferta comercial vigente incluye un único usuario en todos los
      // planes. La infraestructura multiusuario se conserva para el futuro,
      // pero ningún plan actual la habilita.
      multiUser:          false,
      maxUsers:           1,
      advancedReports:    false,
    },
    isActive: true,
  },
  {
    name:        'dominator',
    displayName: 'Dominator',
    price:       79,
    price_ars:   79000,
    currency:    'USD',
    interval:    'month',
    // Fase 3 (19/sep/2026) — mismo criterio que 'closer' arriba. "Reportes
    // avanzados"/"API personalizada"/"Soporte dedicado" quedan retirados del
    // copy: la regla de producto confirmada 19/sep es que los 3 planes
    // comparten las mismas funciones salvo límites numéricos + las 2
    // features exclusivas de Closer/Dominator — no hay un tercer nivel de
    // diferenciación cualitativa. `limits.advancedReports` sigue en `true`
    // acá (no se tocó el entitlement, solo el copy que ya no lo anuncia
    // como diferenciador de marketing).
    features:    [
      'Gestiona hasta 1000 oportunidades de venta activas',
      'CRM Inteligente',
      'WhatsApp Business integrado',
      'IA automática 24/7',
      'Hasta 400 automatizaciones inteligentes',
      'Seguimiento automático',
      'Cierre asistido por IA',
      'Dashboard de ventas',
      'Estadísticas comerciales',
      'Roles y permisos',
      'Soporte prioritario',
    ],
    limits: {
      // Track 2 — ver comentario equivalente en 'closer' arriba: el copy
      // de plan.tsx ("Gestiona hasta 1000 oportunidades de venta activas")
      // ya era correcto, este seed (300) estaba desactualizado.
      leadsPerMonth:      1000,
      aiEnabled:          true,
      automationsEnabled: true,
      maxActiveAutomations: 400,
      whatsappEnabled:    true,
      // La infraestructura multiusuario se conserva, pero la oferta comercial
      // vigente limita también Dominator a un único usuario.
      multiUser:          false,
      maxUsers:           1,
      advancedReports:    true,
    },
    isActive: true,
  },
];

async function seedPlans() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB conectado');

  let stripeClient;
  if (STRIPE_SECRET_KEY) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    console.log('✅ Stripe conectado (creando productos/precios)');
  }

  for (const planData of PLANS) {
    const stripeIds = {};

    if (stripeClient && planData.price > 0) {
      try {
        // Create or find product
        const products = await stripeClient.products.search({
          query: `metadata['planName']:'${planData.name}'`,
        });

        let product;
        if (products.data.length > 0) {
          product = products.data[0];
          console.log(`  ↩  Stripe product exists: ${product.id}`);
        } else {
          product = await stripeClient.products.create({
            name:     `CREA OS ${planData.displayName}`,
            metadata: { planName: planData.name },
          });
          console.log(`  ✅ Stripe product created: ${product.id}`);
        }
        stripeIds.stripeProductId = product.id;

        // Create price
        const prices = await stripeClient.prices.list({ product: product.id, active: true });
        let price;
        if (prices.data.length > 0) {
          price = prices.data[0];
          console.log(`  ↩  Stripe price exists: ${price.id}`);
        } else {
          price = await stripeClient.prices.create({
            product:    product.id,
            unit_amount: planData.price * 100,
            currency:   'usd',
            recurring:  { interval: planData.interval },
            metadata:   { planName: planData.name },
          });
          console.log(`  ✅ Stripe price created: ${price.id}`);
        }
        stripeIds.stripePriceId = price.id;
      } catch (e) {
        console.warn(`  ⚠  Stripe error for ${planData.name}: ${e.message}`);
      }
    }

    const doc = await Plan.findOneAndUpdate(
      { name: planData.name },
      { ...planData, ...stripeIds },
      { upsert: true, new: true, runValidators: true }
    );
    console.log(`✅ Plan "${doc.displayName}" (${doc.name}) OK — Stripe: ${doc.stripePriceId || 'N/A'}`);
  }

  console.log('\n🎉 Plans seed completado');
  await mongoose.disconnect();
}

seedPlans().catch(err => {
  console.error('❌ Error en seed:', err.message);
  process.exit(1);
});
