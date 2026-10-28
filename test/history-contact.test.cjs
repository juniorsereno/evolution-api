const assert = require('node:assert/strict');
const { test } = require('node:test');
const { prepareHistoryContacts } = require('../src/api/integrations/chatbot/chatwoot/utils/history-contact');
const message = (remoteJid, extra = {}) => ({ key: { id: 'synthetic', remoteJid, fromMe: false }, pushName: 'Sender', ...extra });

test('resolves history through the pinned Baileys mapping store and normalizes the device suffix', async () => {
  const { LIDMappingStore } = await import('baileys/lib/Signal/lid-mapping.js');
  const data = new Map();
  const keys = {
    get: async (_type, ids) => Object.fromEntries(ids.map(id => [id, data.get(id)])),
    set: async values => { for (const [key, value] of Object.entries(values['lid-mapping'])) data.set(key, value); },
    transaction: async callback => callback(),
  };
  const logger = { warn() {}, debug() {}, trace() {} };
  const mapping = new LIDMappingStore(keys, logger, async () => []);
  await mapping.storeLIDPNMappings([{ lid: '1234567890123456@lid', pn: '5511999999999@s.whatsapp.net' }]);
  let lookups = 0;
  const original = message('1234567890123456@lid', { pushName: 'Account owner', key: { remoteJid: '1234567890123456@lid', fromMe: true } });
  const contacts = [{ remoteJid: original.key.remoteJid, pushName: 'Recipient from phone agenda' }];
  const rows = await prepareHistoryContacts([original, original], contacts, async lid => { lookups++; return mapping.getPNForLID(lid); });
  assert.equal(lookups, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(rows[0].contactName, 'Recipient from phone agenda');
  assert.equal(original.key.remoteJid, '1234567890123456@lid');
  assert.equal(original.pushName, 'Account owner');
});

test('uses a supplied phone alternate before consulting mappings', async () => {
  const input = message('1234567890123456@lid'); input.key.remoteJidAlt = '5511999999999:0@s.whatsapp.net';
  const rows = await prepareHistoryContacts([input], [], () => { throw Error('Unnecessary mapping lookup'); });
  assert.equal(rows[0].key.remoteJid, '5511999999999@s.whatsapp.net');
});

test('holds unknown LIDs outside phone import and does not use a group alternate', async () => {
  const input = message('1234567890123456@lid'); input.key.remoteJidAlt = '12345@g.us';
  assert.deepEqual(await prepareHistoryContacts([input, message('12345@g.us')], [], async () => null), []);
});

test('never uses the account owner push name for an outgoing peer and ignores numeric placeholders', async () => {
  const outgoing = message('5511999999999@s.whatsapp.net', { pushName: 'Account owner', key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true } });
  const incoming = message('5511888888888@s.whatsapp.net', { pushName: '5511888888888' });
  const rows = await prepareHistoryContacts([outgoing, incoming], [], async () => null);
  assert.equal(rows[0].contactName, undefined);
  assert.equal(rows[1].contactName, undefined);
});
