require('dotenv').config();
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
    features:    [
      '5 leads/mes',
      '1 usuario',
      'CRM básico',
      'Pipeline visual',
      'Soporte por email',
    ],
    limits: {
      leadsPerMonth:      5,
      aiEnabled:          false,
      automationsEnabled: false,
      whatsappEnabled:    false,
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
    features:    [
      '100 leads/mes',
      '3 usuarios',
      'IA Vendedora 24/7',
      'Automatizaciones',
      'WhatsApp Business',
      'Webhooks Meta & TikTok',
      'Soporte prioritario',
    ],
    limits: {
      leadsPerMonth:      100,
      aiEnabled:          true,
      automationsEnabled: true,
      whatsappEnabled:    true,
      multiUser:          true,
      maxUsers:           3,
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
    features:    [
      '300 leads/mes',
      '10 usuarios',
      'IA avanzada con GPT-4o',
      'Automatizaciones ilimitadas',
      'WhatsApp Business',
      'Reportes avanzados',
      'API personalizada',
      'Soporte dedicado',
    ],
    limits: {
      leadsPerMonth:      300,
      aiEnabled:          true,
      automationsEnabled: true,
      whatsappEnabled:    true,
      multiUser:          true,
      maxUsers:           10,
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
