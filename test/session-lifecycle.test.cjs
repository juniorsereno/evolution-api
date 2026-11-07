const assert = require('node:assert/strict');
const { test, before, afterEach, mock } = require('node:test');
const Module = require('node:module');
const EventEmitter2 = require('eventemitter2');
const axios = require('axios');
let Service, configService, baileys, WAMonitoringService, InstanceController;
const subjects = [], sockets = [];
const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function socket() {
  const s = { ws: new EventEmitter2(), endCount: 0, logoutCount: 0, user: { id: '123@s.whatsapp.net' },
    ev: { process: callback => { s.process = callback; } },
    end() { this.endCount++; }, async logout() { this.logoutCount++; throw new Error('closed socket'); } };
  s.ws.close = () => {};
  sockets.push(s); return s;
}
before(async () => {
  baileys = await import('baileys');
  WAMonitoringService = require('../dist/api/server.module').waMonitor.constructor;
  InstanceController = require('../dist/api/server.module').instanceController.constructor;
  const original = Module._load;
  const loader = mock.method(Module, '_load', function (name, ...args) {
    if (name === 'baileys') return { ...baileys, __esModule: true, default: () => socket() };
    return original.call(this, name, ...args);
  });
  try { ({ BaileysStartupService: Service } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service')); }
  finally { loader.mock.restore(); }
  ({ configService } = require('../dist/config/env.config'));
});
afterEach(async () => { for (const s of subjects.splice(0)) { s.messageProcessor.onDestroy(); await s.credentialPersistence?.stop(); } mock.restoreAll(); });
function subject() {
  const writes = [];
  const config = { get(name) {
    if (name === 'DATABASE') return { ...configService.get(name), SAVE_DATA: { INSTANCE: false } };
    if (name === 'CACHE') return { ...configService.get(name), REDIS: { ENABLED: false } };
    if (name === 'PROVIDER' || name === 'CHATWOOT') return { ENABLED: false };
    return configService.get(name);
  } };
  const db = { session: { deleteMany: async args => writes.push(['delete', args]) },
    instance: { update: async args => writes.push(['update', args]) } };
  const s = new Service(config, new EventEmitter2(), db, cache, cache, cache, null);
  s.instance.id = 'synthetic-instance'; s.instance.name = 'synthetic';
  s.defineAuthState = async () => ({ state: { creds: baileys.initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } }, saveCreds: async () => writes.push(['creds']) });
  s.findSettings = async () => ({});
  for (const name of ['loadChatwoot', 'loadSettings', 'loadWebhook', 'loadProxy']) s[name] = async () => {};
  s.sendDataWebhook = async () => {};
  mock.method(axios, 'get', async () => ({ data: '{"client_revision":123456}' }));
  subjects.push(s); return { s, db, writes };
}
async function event(s, client, update) { await client.process(update); await s.eventProcessingQueue; await new Promise(resolve => setImmediate(resolve)); await s.eventProcessingQueue; }
function close(code) { return { 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } } }; }
test('515 replaces socket; late 401 and credentials from old socket cannot close or overwrite replacement', async () => {
  const { s, writes } = subject(); const old = await s.connectToWhatsapp();
  await event(s, old, close(515)); const current = s.client;
  assert.notEqual(current, old);
  await event(s, old, { ...close(401), 'creds.update': {} });
  assert.equal(s.client, current); assert.equal(current.endCount, 0); assert.equal(writes.length, 0);
  await event(s, current, close(401));
  assert.equal(s.connectionStatus.state, 'close'); assert.equal(current.endCount, 1);
  assert.equal(writes[0][1].data.disconnectionReasonCode, 401);
});
test('408 remains reconnectable and duplicate close events create only one replacement', async () => {
  const { s } = subject(); const old = await s.connectToWhatsapp(); const count = sockets.length;
  await Promise.all([old.process(close(408)), old.process(close(408))]); await s.eventProcessingQueue;
  assert.equal(sockets.length, count + 1); assert.notEqual(s.client, old);
});
test('events waiting for settings are discarded when their socket is replaced', async () => {
  const { s, writes } = subject(); const old = await s.connectToWhatsapp(); const wait = deferred();
  s.findSettings = () => wait.promise;
  await old.process({ ...close(401), 'creds.update': {} }); await Promise.resolve();
  const current = await s.restart(); wait.resolve({}); await s.eventProcessingQueue;
  assert.equal(s.client, current); assert.equal(current.endCount, 0); assert.equal(writes.length, 0);
});
test('simultaneous restart requests share one connection and do not log out credentials', async () => {
  const { s, writes } = subject(); const old = await s.connectToWhatsapp(); const count = sockets.length;
  const results = await Promise.all([s.restart(), s.restart()]);
  assert.equal(results[0], results[1]); assert.equal(sockets.length, count + 1);
  assert.equal(old.logoutCount, 0); assert.equal(writes.length, 0);
});
test('logout cancels pending connection and cleans locally even if socket logout fails', async () => {
  const { s, writes } = subject(); const old = await s.connectToWhatsapp(); const wait = deferred();
  s.defineAuthState = () => wait.promise; const count = sockets.length;
  const connecting = s.restart(); const rejected = assert.rejects(connecting, /closed during connection/);
  const logout = s.logoutInstance();
  wait.resolve({ state: { creds: baileys.initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } } });
  await Promise.all([logout, rejected]); assert.equal(sockets.length, count);
  assert.equal(s.connectionStatus.state, 'close');
  assert.deepEqual(writes.map(w => w[0]), ['delete', 'update']); assert.equal(old.endCount, 1);
});
test('duplicate logout shares cleanup; dead socket cannot prevent removal; explicit reconnect still works', async () => {
  const { s, writes } = subject(); const client = await s.connectToWhatsapp();
  await Promise.all([s.logoutInstance(), s.logoutInstance()]);
  assert.equal(client.logoutCount, 1); assert.deepEqual(writes.map(w => w[0]), ['delete', 'update']);
  await event(s, client, close(515)); assert.equal(s.client, client);
  assert.notEqual(await s.connectToWhatsapp(), client);
});
test('removal permanently rejects reconnect on that service and reports persistence failure', async () => {
  const { s, db } = subject(); await s.connectToWhatsapp();
  db.session.deleteMany = async () => { throw new Error('database unavailable'); };
  await assert.rejects(s.prepareForRemoval(), /database unavailable/);
  await assert.rejects(s.connectToWhatsapp(), /closing/);
});
test('logout waits for an in-flight credentials write before deleting the session', async () => {
  const { s, writes } = subject(); const started = deferred(); const release = deferred();
  const auth = await s.defineAuthState(); auth.saveCreds = async () => { started.resolve(); await release.promise; writes.push(['creds']); };
  s.defineAuthState = async () => auth; const client = await s.connectToWhatsapp();
  await client.process({ 'creds.update': {} }); await started.promise;
  const logout = s.logoutInstance(); await Promise.resolve(); assert.equal(writes.length, 0);
  release.resolve(); await logout; assert.deepEqual(writes.map(w => w[0]), ['creds', 'delete', 'update']);
});

function monitor() {
  const emitter = new EventEmitter2();
  const config = { get: name => name === 'CHATWOOT' ? { ENABLED: false } : configService.get(name) };
  const m = new WAMonitoringService(emitter, config, {}, null, cache, cache, cache);
  return { m, emitter, config };
}
test('removal waits for shutdown and both cleanups, coalesces duplicates and preserves another instance', async () => {
  const { m } = monitor(); const release = deferred(); const order = [];
  const a = { prepareForRemoval: async () => { order.push('stop'); await release.promise; }, sendDataWebhook: async () => {} };
  const b = {}; m.waInstances.a = a; m.waInstances.b = b;
  m.cleaningUp = async name => { assert.equal(name, 'a'); order.push('auth'); };
  m.cleaningStoreData = async name => { assert.equal(name, 'a'); order.push('store'); };
  const removals = [m.deleteInstance('a'), m.deleteInstance('a')];
  await Promise.resolve(); assert.deepEqual(order, ['stop']); assert.equal(m.waInstances.a, a);
  release.resolve(); await Promise.all(removals);
  assert.deepEqual(order, ['stop', 'auth', 'store']); assert.equal(m.waInstances.a, undefined); assert.equal(m.waInstances.b, b);
});
test('failed persistence cleanup rejects removal and retains the instance for retry', async () => {
  const { m } = monitor(); const a = { prepareForRemoval: async () => {}, sendDataWebhook: async () => {} };
  m.waInstances.a = a; m.cleaningUp = async () => { throw new Error('cleanup failed'); };
  m.cleaningStoreData = async () => assert.fail('must not run after failed auth cleanup');
  await assert.rejects(m.deleteInstance('a'), /cleanup failed/); assert.equal(m.waInstances.a, a);
  m.cleaningUp = async () => {}; m.cleaningStoreData = async () => {};
  await m.deleteInstance('a'); assert.equal(m.waInstances.a, undefined);
});
test('delete API waits for database cleanup and reports failures instead of success', async () => {
  const { m, emitter, config } = monitor(); const release = deferred();
  m.waInstances.a = { prepareForRemoval: async () => {}, sendDataWebhook: async () => {} };
  m.cleaningUp = async () => {}; m.cleaningStoreData = () => release.promise;
  const controller = new InstanceController(m, config, {}, emitter, null, null, null, cache, cache, cache, null);
  let completed = false; const deleting = controller.deleteInstance({ instanceName: 'a' }).then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  release.resolve(); assert.equal((await deleting).status, 'SUCCESS');
  m.cleaningUp = async () => { throw new Error('database unavailable'); };
  await assert.rejects(controller.deleteInstance({ instanceName: 'a' }), error => error.status === 400 && error.message.includes('Error: database unavailable'));
});
test('pairing credentials in the restart event are persisted before creating the replacement', async () => {
  const { s, writes } = subject(); const old = await s.connectToWhatsapp();
  s.instance.authState.state.creds.registered = true;
  await event(s, old, { ...close(515), 'creds.update': {} });
  assert.notEqual(s.client, old);
  assert.deepEqual(writes.map(w => w[0]), ['creds']);
  assert.equal(s.instance.authState.state.creds.registered, true);
});
test('a genuine logout blocks new connections until its cleanup finishes', async () => {
  const { s } = subject(); const client = await s.connectToWhatsapp(); const started = deferred(); const release = deferred();
  s.eventEmitter.on('logout.instance', async () => { started.resolve(); await release.promise; });
  await client.process(close(401)); await started.promise;
  await assert.rejects(s.connectToWhatsapp(), /closing/);
  release.resolve(); await s.eventProcessingQueue;
  assert.notEqual(await s.connectToWhatsapp(), client);
});

for (const code of [402, 403, 406]) {
  test('current socket status ' + code + ' remains terminal', async () => {
    const { s, writes } = subject(); const client = await s.connectToWhatsapp(); const count = sockets.length;
    await event(s, client, close(code));
    assert.equal(sockets.length, count); assert.equal(s.connectionStatus.state, 'close');
    assert.equal(writes[0][1].data.disconnectionReasonCode, code);
  });
}
test('logout during profile lookup cannot publish a late open status', async () => {
  const { s, writes } = subject(); const client = await s.connectToWhatsapp(); const entered = deferred(), release = deferred();
  s.profilePicture = async () => { entered.resolve(); return release.promise; };
  await client.process({ 'connection.update': { connection: 'open' } }); await entered.promise;
  const logout = s.logoutInstance(); release.resolve({ profilePictureUrl: null }); await logout;
  assert.equal(s.connectionStatus.state, 'close');
  assert.ok(writes.every(w => w[0] !== 'update' || w[1].data.connectionStatus === 'close'));
});
test('QR expiration uses local cleanup even when the socket has already died', async () => {
  const { s, writes } = subject(); const { m, emitter } = monitor(); await s.connectToWhatsapp();
  m.waInstances.synthetic = s; await emitter.emitAsync('no.connection', 'synthetic');
  assert.equal(s.connectionStatus.state, 'close');
  assert.equal(s.instance.qrcode.count, 0); assert.deepEqual(writes.map(w => w[0]), ['delete', 'update']);
});
test('a failed logout webhook does not prevent local authentication cleanup', async () => {
  const { m, emitter } = monitor(); let cleaned = false;
  m.waInstances.synthetic = { sendDataWebhook: async () => { throw new Error('webhook offline'); } };
  m.cleaningUp = async name => { assert.equal(name, 'synthetic'); cleaned = true; };
  await emitter.emitAsync('logout.instance', 'synthetic'); assert.equal(cleaned, true);
});

test('a reported credentials persistence failure does not discard already decoded messages in the same event', async () => {
  const { s } = subject();
  const client = await s.connectToWhatsapp();
  s.instance.authState.saveCreds = async () => { throw new Error('synthetic storage failure'); };
  const received = [], errors = [];
  s.messageHandle['messages.upsert'] = async payload => received.push(...payload.messages);
  mock.method(s.logger, 'error', error => errors.push(error));
  const message = { key: { id: 'synthetic-decoded', remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'Synthetic' } };
  await event(s, client, { 'creds.update': {}, 'messages.upsert': { type: 'notify', messages: [message] } });
  assert.deepEqual(received, [message]);
  assert.equal(errors.some(error => error.event === 'auth.credentials.persistence.failed'), true);
});


test('credentials are retried without a new WhatsApp event and retain the latest state across reconnect', async () => {
  const { s } = subject();const client=await s.connectToWhatsapp();
  const state=s.instance.authState;let attempts=0,saved;
  state.saveCreds=async()=>{if(++attempts===1)throw Error('temporary storage outage');saved=state.state.creds.registered;};
  await event(s,client,{'creds.update':{}});state.state.creds.registered=true;
  await s.restart();assert.equal(s.instance.authState.state.creds.registered,true);
  await new Promise(r=>setTimeout(r,1150));assert.equal(saved,true);assert.equal(attempts,2);
});

test('logout cancels a scheduled credential retry before deleting authentication', async()=>{
 const {s}=subject();const client=await s.connectToWhatsapp();let writes=0;
 s.instance.authState.saveCreds=async()=>{writes++;throw Error('synthetic offline');};
 await event(s,client,{'creds.update':{}});await s.logoutInstance();await new Promise(r=>setTimeout(r,1150));assert.equal(writes,1);
});
test('logout waits for a retry already saving credentials before deleting the session',async()=>{
 const {s,db}=subject();const client=await s.connectToWhatsapp();const entered=deferred(),release=deferred();let attempts=0,deleted=false;
 s.instance.authState.saveCreds=async()=>{if(++attempts===1)throw Error('synthetic offline');entered.resolve();await release.promise;};
 db.session.deleteMany=async()=>{deleted=true;};
 await event(s,client,{'creds.update':{}});await entered.promise;
 const closing=s.logoutInstance();await new Promise(r=>setImmediate(r));assert.equal(deleted,false);
 release.resolve();await closing;assert.equal(deleted,true);assert.equal(attempts,2);
});
