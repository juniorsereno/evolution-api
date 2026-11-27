const assert = require('node:assert/strict');
const { test } = require('node:test');
const EventEmitter2 = require('eventemitter2');
const qrcode = require('qrcode');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');

test('refreshes an existing QR at the attempt limit and publishes only the current render', async (t) => {
  const { buildPairingQRData } = await import('baileys');
  const qr = (reference, secret) => buildPairingQRData(reference, 'noise', 'identity', secret, ['Windows', 'Desktop', '10']);
  const renders = new Map();
  t.mock.method(qrcode, 'toDataURL', (code, _options, callback) => renders.set(code, callback));
  const config = {
    get(name) {
      if (name === 'QRCODE') return { LIMIT: 1, COLOR: '#000000' };
      if (name === 'CHATWOOT') return { ENABLED: false };
      return configService.get(name);
    },
  };
  const events = new EventEmitter2();
  const prisma = { instance: { update: async () => {} } };
  const service = new BaileysStartupService(config, events, prisma, {}, {}, {}, null);
  service.instance.id = 'synthetic-qr-id';
  service.instance.name = 'synthetic-qr-name';
  service.client = {};
  service.getProfileName = async () => null;
  const updates = [];
  service.sendDataWebhook = (_event, payload) => updates.push(payload);

  try {
    const initial = qr('ref-1', 'first');
    const refreshed = qr('ref-1', 'refreshed');
    await service.connectionUpdate({ qr: initial });
    await service.connectionUpdate({ qr: refreshed });
    renders.get(refreshed)(null, 'synthetic-fresh-image');
    renders.get(initial)(null, 'synthetic-obsolete-image');
    assert.equal(service.qrCode.count, 1);
    assert.equal(service.qrCode.code, refreshed);
    assert.deepEqual(updates.map(payload => payload.qrcode?.code), [refreshed]);

    const next = qr('ref-2', 'refreshed');
    await service.connectionUpdate({ qr: next });
    assert.equal(renders.has(next), false);
    assert.equal(updates.at(-1).state, 'refused');
  } finally {
    service.messageProcessor.onDestroy();
    service.userDevicesCache.close();
    service.msgRetryCounterCache.close();
  }
});
