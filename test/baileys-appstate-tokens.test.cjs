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
  const { patch, state } = await utils.encodeSyncdPatch({ type: 'regular', index: ['archive','synthetic'], syncAction: { archiveChatAction: { archived: true } }, apiVersion: 0, operation: sdk.proto.SyncdMutation.SyncdOperation.SET }, id.toString('base64'), utils.newLTHashState(), get);
  return { bad, mac, get, patch, state, good: patch.mutations[0].record };
}
test('installed SDK rejects arbitrary opaque indexes and recovers from a verified snapshot', async () => {
  const { bad, get, good, patch, state } = await fixtures();
  const initial = utils.newLTHashState();
  for (const validate of [true, false]) {
    for (const blob of [randomBytes(32), randomBytes(32)]) {
      await assert.rejects(utils.decodeSyncdMutations([{ ...bad, index: { blob } }], initial, get, () => {}, validate), { name: 'AppStateRecordDecodeError' });
    }
  }
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.indexValueMap, {});
  assert.deepEqual(initial.hash, Buffer.alloc(128));
  const recovered = await utils.decodeSyncdSnapshot('regular', { version: { version: state.version }, records: [good], keyId: good.keyId, mac: patch.snapshotMac }, get, undefined, true);
  assert.equal(recovered.state.version, 1);
  assert.equal(Object.keys(recovered.mutationMap).length, 1);
});
test('installed SDK rejects an unauthenticated malformed patch without advancing state', async () => {
  const { bad, get } = await fixtures();
  bad.value.blob[bad.value.blob.length - 1] ^= 1;
  const initial = utils.newLTHashState();
  await assert.rejects(utils.decodePatches('regular', [{ version: { version: 1 }, mutations: [{ operation: 0, record: bad }] }], initial, get, {}, undefined, undefined, false), { name: 'AppStateRecordDecodeError' });
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.indexValueMap, {});
});
