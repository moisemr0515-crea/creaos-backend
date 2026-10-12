/**
 * Migra verifyToken/accessToken legacy de WebhookConfig a AES-256-GCM.
 *
 * Seguro por defecto:
 *   node scripts/migrate-webhook-secrets.js            # dry-run
 *   node scripts/migrate-webhook-secrets.js --dry-run  # dry-run explícito
 *   node scripts/migrate-webhook-secrets.js --apply    # escritura explícita
 *
 * Nunca imprime secretos. Puede ejecutarse varias veces: los campos ya
 * cifrados se verifican y reportan ALREADY_ENCRYPTED.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const WebhookConfig = require('../src/modules/webhooks/webhookConfig.model');
const { migrateWebhookSecrets } = require('../src/modules/webhooks/webhookConfigMigration.service');

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !['--dry-run', '--apply'].includes(arg));
if (unknown.length || (args.has('--dry-run') && args.has('--apply'))) {
  process.stderr.write('Uso: node scripts/migrate-webhook-secrets.js [--dry-run|--apply]\n');
  process.exitCode = 2;
} else if (require.main === module) {
  const apply = args.has('--apply');
  const run = async () => {
    if (!MONGODB_URI) throw new Error('MONGODB_URI no configurada');
    await mongoose.connect(MONGODB_URI);
    process.stdout.write(`Modo: ${apply ? 'APPLY' : 'DRY_RUN'}\n`);
    const results = await migrateWebhookSecrets({
      WebhookConfig,
      apply,
      report: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
    });
    const summary = results.reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1;
      return acc;
    }, {});
    process.stdout.write(`Resumen: ${JSON.stringify(summary)}\n`);
    await mongoose.disconnect();
    if (summary.FAILED) process.exitCode = 1;
  };
  run().catch(async (_error) => {
    process.stderr.write('Migración fallida; consulte logs sanitizados de operación.\n');
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
