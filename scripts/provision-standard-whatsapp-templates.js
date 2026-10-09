const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const WhatsAppChannel = require('../src/modules/channels/whatsappChannel.model');
const { STANDARD_TEMPLATE_PACK } = require('../src/modules/channels/standardTemplate.pack');
const { ensureStandardTemplatesForChannel } = require('../src/modules/channels/standardTemplate.service');

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

async function main() {
  const channelId = option('--channel-id');
  const tenantId = option('--tenant-id');
  const confirmed = process.argv.includes('--confirm');
  if (!channelId || !tenantId) throw new Error('Uso: --channel-id ID --tenant-id ID [--confirm]');
  await mongoose.connect(MONGODB_URI);
  const channel = await WhatsAppChannel.findOne({ _id: channelId, tenantId, businessId: tenantId, status: 'active' });
  if (!channel) throw new Error('Canal activo no encontrado o fuera del tenant');
  if (!confirmed) {
    console.log(JSON.stringify({ channelId, tenantId, mode: 'dry-run', standardTemplates: STANDARD_TEMPLATE_PACK.map((item) => item.name) }));
    return;
  }
  const result = await ensureStandardTemplatesForChannel(channelId, tenantId);
  console.log(JSON.stringify(result));
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());