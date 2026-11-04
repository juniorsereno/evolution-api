const assert = require('node:assert/strict');
const { before, after, test, mock } = require('node:test');
const { Readable } = require('node:stream');
const EventEmitter2 = require('eventemitter2');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
let subject;
const bytes = Buffer.from('synthetic attachment');
before(() => {
  subject = new BaileysStartupService(configService, new EventEmitter2(), {}, cache, cache, cache, null);
  mock.method(globalThis, 'fetch', async () => { throw new Error('Standalone network download is forbidden'); });
  const timeout = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => timeout(callback, delay === 5000 ? 0 : delay, ...args));
});
after(() => { subject?.messageProcessor.onDestroy(); mock.restoreAll(); });
function message(type) {
  return { key: { id: 'synthetic-media', remoteJid: '123@lid' }, message: {
    [type + 'Message']: { mediaKey: Buffer.alloc(32), directPath: '/synthetic', url: 'https://original.example/synthetic', mimetype: type === 'audio' ? 'audio/ogg' : type === 'image' ? 'image/png' : 'application/octet-stream' }
  }};
}
for (const type of ['image', 'audio', 'video', 'document']) {
  test(`media endpoint uses its socket for ${type}`, async () => {
    const calls = [];
    const updateMediaMessage = async msg => msg;
    subject.client = { updateMediaMessage, downloadMediaMessage: async (...args) => { calls.push(args); return bytes; } };
    const result = await subject.getBase64FromMediaMessage({ message: message(type) }, true);
    assert.equal(result.base64, bytes.toString('base64'));
    assert.deepEqual(result.buffer, bytes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][3].reuploadRequest, updateMediaMessage);
  });
}
test('media fallback also uses the socket and preserves the message URL', async () => {
  const calls = [];
  subject.client = {
    downloadMediaMessage: async () => { throw new Error('synthetic primary failure'); },
    downloadContentFromMessage: async (...args) => { calls.push(args); return Readable.from([bytes]); }
  };
  const result = await subject.getBase64FromMediaMessage({ message: message('image') });
  assert.equal(result.base64, bytes.toString('base64'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].url, 'https://original.example/synthetic');
  assert.equal(calls[0][1], 'image');
});
test('a socket download failure is reported instead of returning a false success', async () => {
  subject.client = {
    downloadMediaMessage: async () => { throw new Error('synthetic primary failure'); },
    downloadContentFromMessage: async () => { throw new Error('synthetic fallback failure'); }
  };
  await assert.rejects(subject.getBase64FromMediaMessage({ message: message('image') }), error => error.status === 400 && error.message.includes('Error: synthetic fallback failure'));
});
