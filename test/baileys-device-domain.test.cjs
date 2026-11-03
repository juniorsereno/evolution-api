const assert = require('node:assert/strict');
const { test } = require('node:test');
for (const domain of ['s.whatsapp.net', 'lid']) {
  test(`installed SDK isolates hosted device domains for ${domain}`, async () => {
    const { extractDeviceJids } = await import('baileys/lib/Utils/signal.js');
    const devices = extractDeviceJids([{ id: `123456@${domain}`, devices: { deviceList: [
      { id: 1, keyIndex: 1, isHosted: true }, { id: 2, keyIndex: 2, isHosted: false },
    ] } }], '999:0@s.whatsapp.net', '888:0@lid', false);
    assert.equal(devices.length, 2);
    assert.equal(devices[1].server, domain);
    assert.notEqual(devices[0].server, devices[1].server);
  });
}
