const assert = require('node:assert/strict');
const { test, before, afterEach } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const logger = require('pino')({ level: 'silent' });
let sdk, makeLibSignalRepository;
const cleanup = [];
before(async () => {
  sdk = await import('baileys');
  ({ makeLibSignalRepository } = await import('baileys/lib/Signal/libsignal.js'));
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function peer(jid) {
  const folder = await mkdtemp(join(tmpdir(), 'evolution-signal-fixture-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const { state } = await sdk.useMultiFileAuthState(folder);
  const keys = sdk.addTransactionCapability(state.keys, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 });
  const repo = makeLibSignalRepository({ creds: state.creds, keys }, logger);
  cleanup.push(() => repo.close());
  const preKey = sdk.Curve.generateKeyPair();
  await keys.set({ 'pre-key': { '1': preKey } });
  return { jid, keys, repo, store: state.keys, bundle: {
    registrationId: state.creds.registrationId,
    identityKey: sdk.generateSignalPubKey(state.creds.signedIdentityKey.public),
    signedPreKey: { keyId: state.creds.signedPreKey.keyId, publicKey: sdk.generateSignalPubKey(state.creds.signedPreKey.keyPair.public), signature: state.creds.signedPreKey.signature },
    preKey: { keyId: 1, publicKey: sdk.generateSignalPubKey(preKey.public) },
  } };
}
test('installed SDK preserves every concurrent PN/LID message under an outer send transaction', async () => {
  const alice = await peer('12025550101@s.whatsapp.net'), bob = await peer('12025550102@s.whatsapp.net');
  const lid = '100000000002@lid';
  await alice.repo.lidMapping.storeLIDPNMappings([{ pn: bob.jid, lid }]);
  await alice.repo.injectE2ESession({ jid: bob.jid, session: bob.bundle });
  const payloads = Array.from({ length: 12 }, (_, i) => Buffer.from(`fixture-${i}`));
  const encrypted = await alice.keys.transaction(() => Promise.all(payloads.map((data, i) => alice.repo.encryptMessage({ jid: i % 2 ? lid : bob.jid, data }))), 'outbound');
  const received = [];
  for (const message of encrypted) received.push(await bob.repo.decryptMessage({ jid: alice.jid, ...message }));
  assert.deepEqual(received, payloads);
});
test('installed SDK retains inner locks until outer session persistence completes', async () => {
  const writes = [];
  const keys = sdk.addTransactionCapability({ get: async () => ({}), set: async data => writes.push(Buffer.from(data.session.peer).toString()) }, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 });
  let signal, release;
  const ready = new Promise(resolve => { signal = resolve; }), finish = new Promise(resolve => { release = resolve; });
  const first = keys.transaction(async () => {
    await keys.transactWith({ records: [{ type: 'session', id: 'peer' }] }, async () => keys.set({ session: { peer: Buffer.from('first') } }));
    signal(); await finish;
  }, 'outbound');
  await ready;
  const second = keys.transactWith({ records: [{ type: 'session', id: 'peer' }] }, async () => keys.set({ session: { peer: Buffer.from('second') } }));
  await new Promise(resolve => setImmediate(resolve));
  const premature = [...writes]; release();
  await Promise.all([first, second]);
  assert.deepEqual(premature, []); assert.deepEqual(writes, ['first', 'second']);
});

test('installed SDK retries PN/LID migration after a durable write failure', async () => {
  const alice = await peer('12025550101@s.whatsapp.net'), bob = await peer('12025550102@s.whatsapp.net');
  const lid = '100000000002@lid';
  await alice.repo.injectE2ESession({ jid: bob.jid, session: bob.bundle });
  await alice.keys.set({ 'device-list': { '12025550102': ['0'] } });
  const write = alice.store.set.bind(alice.store);
  let fail = true;
  alice.store.set = async data => {
    if (fail) { fail = false; throw new Error('fixture migration write failure'); }
    return write(data);
  };
  await assert.rejects(alice.repo.migrateSession(bob.jid, lid), /fixture migration write failure/);
  assert.equal((await alice.repo.migrateSession(bob.jid, lid)).migrated, 1);
  await alice.repo.lidMapping.storeLIDPNMappings([{ pn: bob.jid, lid }]);
  const encrypted = await alice.repo.encryptMessage({ jid: lid, data: Buffer.from('migration retried') });
  assert.deepEqual(await bob.repo.decryptMessage({ jid: alice.jid, ...encrypted }), Buffer.from('migration retried'));
});
