const assert = require('node:assert/strict');
const { before, afterEach, after, test, mock } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const pino = require('pino');
let makeSocket, makeMessagesRecvSocket, defaults, useMultiFileAuthState, binary;
const clients = new WeakMap(), cleanup = [];
before(async () => {
  const { WebSocketClient } = await import('baileys/lib/Socket/Client/websocket.js');
  binary = await import('baileys/lib/WABinary/index.js');
  mock.method(WebSocketClient.prototype, 'connect', () => {});
  mock.getter(WebSocketClient.prototype, 'isOpen', () => true);
  mock.getter(WebSocketClient.prototype, 'isClosed', () => false);
  mock.method(WebSocketClient.prototype, 'close', async () => {});
  mock.method(WebSocketClient.prototype, 'send', function(data, callback) {
    const context = clients.get(this);
    const frame = Buffer.from(data);
    binary.decodeBinaryNode(frame.subarray(frame[0] === 87 ? 7 : 3)).then(node => {
      context.nodes.push(node);
      context.notify();
      if (context.failures-- > 0) return callback(new Error('Synthetic transport failure'));
      if (!context.hold && node.tag === 'iq') context.ack(node);
      callback();
    }).catch(callback);
    return true;
  });
  ({ makeSocket } = await import('baileys/lib/Socket/socket.js'));
  ({ makeMessagesRecvSocket } = await import('baileys/lib/Socket/messages-recv.js'));
  ({ DEFAULT_CONNECTION_CONFIG: defaults } = await import('baileys/lib/Defaults/index.js'));
  ({ useMultiFileAuthState } = await import('baileys/lib/Utils/use-multi-file-auth-state.js'));
});
afterEach(async () => { for (const clear of cleanup.splice(0)) await clear(); });
after(() => mock.restoreAll());
async function create(receive = false, manager = false, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-retry-fixture-'));
  const { state } = await useMultiFileAuthState(dir);
  const counters = new Map([['synthetic-retry:undefined', 2]]);
  const cache = {
    async get(key) { const value = counters.get(key); await new Promise(resolve => setImmediate(resolve)); return value; },
    async set(key, value) { await new Promise(resolve => setImmediate(resolve)); counters.set(key, value); },
    del: key => counters.delete(key), flushAll: () => counters.clear(),
  };
  if (receive) { state.creds.me = { id: '123@s.whatsapp.net' }; state.creds.account = {}; }
  const sock = (receive ? makeMessagesRecvSocket : makeSocket)({
    ...defaults, auth: state, logger: pino({ level: 'silent' }), fireInitQueries: false,
    defaultQueryTimeoutMs: 100, connectTimeoutMs: 100, enableRecentMessageCache: manager,
    enableAutoSessionRecreation: false, msgRetryCounterCache: cache,
    transactionOpts: { maxCommitRetries: 1, delayBetweenTriesMs: 1 }, ...overrides,
  });
  const context = { nodes: [], failures: 0, hold: false, notify() {},
    ack(node) { sock.ws.emit('TAG:' + node.attrs.id, { tag: 'iq', attrs: { id: node.attrs.id, type: 'result' } }); } };
  clients.set(sock.ws, context);
  cleanup.push(async () => { await sock.end(undefined); await rm(dir, { recursive: true, force: true }); });
  return { sock, state, context, counters };
}
function ids(node) {
  return binary.getBinaryNodeChildren(binary.getBinaryNodeChild(node, 'list'), 'key').map(key => {
    const bytes = Buffer.from(binary.getBinaryNodeChild(key, 'id').content);
    return bytes.readUIntBE(0, bytes.length);
  });
}
test('installed SDK confirms upload progress only after the server acknowledges persisted keys', async () => {
  const { sock, state, context } = await create();
  context.hold = true;
  const sent = new Promise(resolve => { context.notify = resolve; });
  const upload = sock.uploadPreKeys(2);
  await sent;
  const before = state.creds.firstUnuploadedPreKeyId;
  context.ack(context.nodes[0]);
  await upload;
  assert.equal(before, 1);
  assert.equal(state.creds.nextPreKeyId, 3);
  assert.equal(state.creds.firstUnuploadedPreKeyId, 3);
  assert.deepEqual(ids(context.nodes[0]), [1, 2]);
});
test('installed SDK reuses persisted keys across a failed upload and concurrent callers', async () => {
  const { sock, state, context } = await create();
  context.failures = 1;
  await Promise.all([sock.uploadPreKeys(2), sock.uploadPreKeys(2)]);
  assert.deepEqual(context.nodes.map(ids), [[1, 2], [1, 2]]);
  assert.equal(state.creds.firstUnuploadedPreKeyId, 3);
});
for (const manager of [false, true]) {
  test('installed SDK serializes retries and retains the limit; recent manager=' + manager, async () => {
    const { sock, counters, context } = await create(true, manager);
    sock.messageRetryManager?.incrementRetryCount('synthetic-retry');
    sock.messageRetryManager?.incrementRetryCount('synthetic-retry');
    const node = { tag: 'message', attrs: { from: '456@s.whatsapp.net', id: 'synthetic-retry', type: 'text', t: '1700000000' } };
    await Promise.all([sock.sendRetryRequest(node), sock.sendRetryRequest(node)]);
    await sock.sendRetryRequest(node);
    await sock.sendRetryRequest(node);
    await sock.sendRetryRequest(node);
    const counts = context.nodes.filter(n => n.tag === 'receipt' && n.attrs.type === 'retry')
      .map(n => Number(binary.getBinaryNodeChild(n, 'retry').attrs.count)).sort();
    assert.deepEqual(counts, [3, 4, 5]);
    assert.equal(counters.get('synthetic-retry:undefined'), 5);
  });
}

test('installed SDK prevents a retry from consuming a prekey in an unconfirmed upload', async () => {
  const { sock, context, counters } = await create(true, false);
  context.hold = true;
  const sent = new Promise(resolve => { context.notify = resolve; });
  const upload = sock.uploadPreKeys(2);
  await sent;
  const uploadNode = context.nodes.find(n => n.tag === 'iq');
  const transaction = mock.method(sock.authState.keys, 'transaction');
  const set = counters.set.bind(counters);
  const reserved = new Promise(resolve => {
    mock.method(counters, 'set', (key, value) => { const result = set(key, value); resolve(); return result; });
  });
  const retry = sock.sendRetryRequest({ tag: 'message', attrs: {
    from: '456@s.whatsapp.net', id: 'synthetic-retry', type: 'text', t: '1700000000',
  } });
  await reserved;
  await new Promise(resolve => setImmediate(resolve));
  const early = transaction.mock.callCount();
  context.ack(uploadNode);
  await Promise.all([upload, retry]);
  assert.equal(early, 0);
  const receipt = context.nodes.find(n => n.tag === 'receipt' && n.attrs.type === 'retry');
  const key = binary.getBinaryNodeChild(binary.getBinaryNodeChild(receipt, 'keys'), 'key');
  const bytes = Buffer.from(binary.getBinaryNodeChild(key, 'id').content);
  assert.equal(bytes.readUIntBE(0, bytes.length), 3);
});

test('installed SDK persists a delayed privacy-token response outside the completed send transaction', async () => {
  const { sock, state, context } = await create(true, false, { defaultQueryTimeoutMs: 2000, connectTimeoutMs: 2000 });
  for (const user of ['123','456']) await sock.userDevicesCache.set(user, [{ user, device: 1, server: 's.whatsapp.net' }]);
  mock.method(sock.signalRepository, 'validateSession', async () => ({ exists: true }));
  mock.method(sock.signalRepository, 'encryptMessage', async () => ({ type: 'msg', ciphertext: Buffer.from('synthetic-encryption') }));
  context.hold = true;
  await sock.authState.keys.transaction(() => sock.relayMessage('456@s.whatsapp.net', { conversation: 'synthetic' }, { messageId: 'synthetic-token-send' }), 'parent-send');
  for (let i=0;i<100 && !context.nodes.some(n=>n.attrs.xmlns==='privacy');i++) await new Promise(r=>setTimeout(r,5));
  const iq = context.nodes.find(n=>n.attrs.xmlns==='privacy');
  assert.ok(iq);
  context.ack(iq);
  let timestamp;
  for (let i=0;i<100;i++) {
    timestamp = (await state.keys.get('tctoken',['456@s.whatsapp.net']))['456@s.whatsapp.net']?.senderTimestamp;
    if (timestamp) break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(typeof timestamp, 'number');
});
