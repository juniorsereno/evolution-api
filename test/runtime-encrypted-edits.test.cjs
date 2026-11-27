const assert = require('node:assert/strict');
const { createCipheriv, hkdfSync } = require('node:crypto');
const { test } = require('node:test');
const EventEmitter2 = require('eventemitter2');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { decryptMessageEdit } = require('../dist/api/integrations/channel/whatsapp/encrypted-message-edit');

const sender = '100000000011@lid';
const own = '100000000099@lid';
const originalKey = { id: 'synthetic-original', remoteJid: sender, fromMe: false };
const secret = Buffer.alloc(32, 42);

function encryptedEdit(proto, eventId, editText, time, outerKey = {}, authors = [sender, sender]) {
  const target = { id: originalKey.id, remoteJid: own, fromMe: true };
  const bytes = proto.Message.encode({
    protocolMessage: { key: target, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage: { conversation: editText } },
  }).finish();
  const info = Buffer.from(originalKey.id + authors.join('') + 'Message Edit');
  const iv = Buffer.alloc(12, time);
  const key = hkdfSync('sha256', secret, Buffer.alloc(0), info, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  return {
    key: { ...originalKey, id: eventId, ...outerKey },
    messageTimestamp: time,
    message: { secretEncryptedMessage: {
      targetMessageKey: target,
      secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
      encPayload: payload,
      encIv: iv,
    } },
  };
}

test('encrypted edits keep the original secret and publish a notice linked to the original', async () => {
  const { proto } = await import('baileys');
  const original = {
    id: 'stored-original', key: originalKey, messageTimestamp: 10,
    message: { conversation: 'Initial text', messageContextInfo: { messageSecret: secret.toString('base64') } },
    chatwootConversationId: 42, chatwootMessageId: 100,
  };
  const webhook = [];
  const audit = [];
  const notices = [];
  const cache = new Map();
  const settings = { get: key => key === 'CHATWOOT' ? { ENABLED: true } : { SAVE_DATA: {} } };
  const api = new BaileysStartupService(settings, new EventEmitter2(), {
    message: { update: async ({ data }) => Object.assign(original, data) },
    messageUpdate: { create: async ({ data }) => audit.push(data) },
    chat: { findFirst: async () => { throw new Error('Encrypted edit must not enter ordinary message processing'); } },
  }, {}, {}, {}, null);
  api.instance = { id: 'synthetic-instance-id', name: 'synthetic-instance' };
  api.client = { user: { id: '12025550100:1@s.whatsapp.net', lid: own } };
  api.getMessage = async key => key.id === originalKey.id ? original : undefined;
  api.sendDataWebhook = async (_event, event) => { webhook.push(event); };
  api.baileysCache = { get: async key => cache.get(key), set: async (key, value) => cache.set(key, value) };
  api.localChatwoot.enabled = true;
  const mirror = new ChatwootService({ waInstances: { 'synthetic-instance': api } }, settings, {}, {});
  mirror.clientCw = async () => ({});
  mirror.getMessageByKeyId = async () => original;
  mirror.createMessage = async (...args) => { notices.push(args); return { id: 101 }; };
  api.chatwootService = mirror;
  const receive = (...messages) => api.messageHandle['messages.upsert']({ messages, type: 'notify' }, {});

  try {
    const first = encryptedEdit(proto, 'synthetic-edit-one', 'First edit', 20);
    await receive(first);
    assert.equal(original.message.conversation, 'First edit');
    assert.equal(original.message.messageContextInfo.messageSecret, secret.toString('base64'));
    await receive(first, encryptedEdit(proto, 'synthetic-edit-two', 'Second edit', 25));
    assert.equal(original.message.conversation, 'Second edit');
    assert.deepEqual(notices.map(args => [args[7], args[8].chatwootMessageId]), [
      ['WAID:synthetic-edit-one', 100],
      ['WAID:synthetic-edit-two', 100],
    ]);
    assert.equal(webhook.length, 2);
    assert.deepEqual(webhook[0].key, originalKey);
    assert.equal(audit.length, 2);

    const tampered = encryptedEdit(proto, 'tampered', 'Tampered', 30);
    tampered.message.secretEncryptedMessage.encPayload[0] ^= 1;
    await receive(tampered, encryptedEdit(proto, 'foreign', 'Foreign', 30, { remoteJid: '100000000012@lid' }));
    await receive(encryptedEdit(proto, 'stale', 'Older version', 22));
    assert.equal(original.message.conversation, 'Second edit');
    assert.equal(notices.length, 2);
  } finally {
    api.messageProcessor.onDestroy();
    await api.credentialPersistence?.stop();
    api.userDevicesCache.close();
    api.msgRetryCounterCache.close();
    await mirror.pgClient.end();
  }
});

test('a group edit can use a verified PN/LID alias and cannot rewrite another participant’s message', async () => {
  const { proto } = await import('baileys');
  const group = '120363000000001@g.us';
  const phone = '12025550101@s.whatsapp.net';
  const unrelated = '100000000012@lid';
  const key = { ...originalKey, remoteJid: group, participant: sender, participantAlt: phone };
  const original = { key, message: { messageContextInfo: { messageSecret: secret } } };

  const legitimate = encryptedEdit(
    proto, 'valid-group-edit', 'Edited', 50, { remoteJid: group, participant: phone }, [sender, phone],
  );
  const edit = decryptMessageEdit(legitimate.message.secretEncryptedMessage, legitimate.key, original);
  assert.equal(edit.editedMessage.conversation, 'Edited');
  assert.deepEqual(edit.key, key);

  const forged = encryptedEdit(
    proto, 'foreign-group-edit', 'Unauthorized', 51, { remoteJid: group, participant: unrelated }, [unrelated, unrelated],
  );
  assert.equal(decryptMessageEdit(forged.message.secretEncryptedMessage, forged.key, original), undefined);
});
