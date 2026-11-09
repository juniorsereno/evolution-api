const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { randomBytes } = require('node:crypto');
let sdk, utils, crypto, expandAppStateKeys;
before(async () => {
  sdk = await import('baileys');
  utils = await import('baileys/lib/Utils/chat-utils.js');
  crypto = await import('baileys/lib/Utils/crypto.js');
  ({ expandAppStateKeys } = await import('whatsapp-rust-bridge'));
});
async function fixtures() {
  const id = randomBytes(16), key = randomBytes(32);
  const get = async keyId => keyId === id.toString('base64') ? { keyData: key } : null;
  const keys = expandAppStateKeys(key);
  const encrypted = crypto.aesEncrypt(Buffer.from([63]), keys.valueEncryptionKey);
  const prefix = Buffer.concat([Buffer.from([1]), id]);
  const length = Buffer.alloc(8); length[7] = prefix.length;
  const mac = crypto.hmacSign(Buffer.concat([prefix, encrypted, length]), keys.valueMacKey, 'sha512').subarray(0, 32);
  const bad = { keyId: { id }, index: { blob: randomBytes(32) }, value: { blob: Buffer.concat([encrypted, mac]) } };
  const { patch } = await utils.encodeSyncdPatch({ type: 'regular', index: ['archive','synthetic'], syncAction: { archiveChatAction: { archived: true } }, apiVersion: 0, operation: sdk.proto.SyncdMutation.SyncdOperation.SET }, id.toString('base64'), utils.newLTHashState(), get);
  return { bad, mac, get, good: patch.mutations[0].record };
}
test('installed SDK retains valid app-state actions and the hash of an authenticated undecodable record', async () => {
  const { bad, mac, get, good } = await fixtures();
  const seen = [];
  const state = await utils.decodeSyncdMutations([bad, good], utils.newLTHashState(), get, action => seen.push(action), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(state.indexValueMap[Buffer.from(bad.index.blob).toString('base64')].valueMac, mac);
});
test('installed SDK rejects an unauthenticated malformed patch without advancing state', async () => {
  const { bad, get } = await fixtures();
  bad.value.blob[bad.value.blob.length - 1] ^= 1;
  const initial = utils.newLTHashState();
  await assert.rejects(utils.decodePatches('regular', [{ version: { version: 1 }, mutations: [{ operation: 0, record: bad }] }], initial, get, {}, undefined, undefined, false), { name: 'AppStateRecordDecodeError' });
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.indexValueMap, {});
});
