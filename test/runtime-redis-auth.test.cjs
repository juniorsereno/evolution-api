const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const { createClient } = require('redis');
const uri = process.env.AUTH_TEST_REDIS_URI;
if (!uri || !['127.0.0.1','evolution-auth-redis'].includes(new URL(uri).hostname)) throw Error('Use the task-owned Redis container');
process.env.CACHE_REDIS_ENABLED='true';
process.env.CACHE_REDIS_URI=uri;
process.env.CACHE_REDIS_SAVE_INSTANCES='true';
process.env.CACHE_REDIS_PREFIX_KEY='synthetic-auth-persistence';
process.env.CACHE_LOCAL_ENABLED='false';
const { configService } = require('../dist/config/env.config');
const { CacheEngine } = require('../dist/cache/cacheengine');
const { CacheService } = require('../dist/api/services/cache.service');
const { useMultiFileAuthStateRedisDb } = require('../dist/utils/use-multi-file-auth-state-redis-db');
const admin=createClient({url:uri});
const instance='synthetic-session', key='synthetic-auth-persistence:instance:'+instance;
let cache, client;
before(async()=>{
 await admin.connect();
 const engine=new CacheEngine(configService,'instance','throw').getEngine();
 cache=new CacheService(engine,'throw');
 client=engine.client;await client.ping();
});
beforeEach(async()=>{await admin.configSet('min-replicas-to-write','0');await admin.del(key);});
afterEach(async()=>{await admin.configSet('min-replicas-to-write','0');await admin.del(key);});
after(async()=>{await client.quit();await admin.quit();});
async function rejectWrites(){await admin.configSet('min-replicas-to-write','1');}
test('existing double-encoded credentials and binary keys keep their wire format across restart',async()=>{
 const auth=await useMultiFileAuthStateRedisDb(instance,cache);
 await auth.saveCreds();await auth.state.keys.set({session:{peer:Buffer.from('synthetic-session-state')}});
 const raw=await admin.hGet(key,'creds');assert.equal(typeof JSON.parse(raw),'string');
 const restored=await useMultiFileAuthStateRedisDb(instance,cache);
 assert.deepEqual(restored.state.creds.noiseKey,auth.state.creds.noiseKey);
 assert.deepEqual((await restored.state.keys.get('session',['peer'])).peer,Buffer.from('synthetic-session-state'));
 await restored.saveCreds();assert.equal(await admin.hGet(key,'creds'),raw);
});
test('a Redis read error rejects loading instead of creating a replacement identity',async()=>{
 await admin.set(key,'wrong-type');
 await assert.rejects(useMultiFileAuthStateRedisDb(instance,cache),/WRONGTYPE/);
 assert.equal(await admin.get(key),'wrong-type');
});
test('malformed existing credentials are rejected instead of replaced',async()=>{
 await admin.hSet(key,'creds',JSON.stringify('malformed-json'));
 await assert.rejects(useMultiFileAuthStateRedisDb(instance,cache),SyntaxError);
 assert.equal(await admin.hGet(key,'creds'),JSON.stringify('malformed-json'));
});
test('failed durable credentials and key writes reject, retain old data, and can be retried',async()=>{
 const auth=await useMultiFileAuthStateRedisDb(instance,cache);await auth.saveCreds();
 await auth.state.keys.set({session:{peer:Buffer.from('old')}});
 const original=await admin.hGet(key,'creds');auth.state.creds.registered=true;
 await rejectWrites();
 await assert.rejects(auth.saveCreds(),/NOREPLICAS/);
 await assert.rejects(auth.state.keys.set({session:{peer:Buffer.from('new')}}),/NOREPLICAS/);
 assert.equal(await admin.hGet(key,'creds'),original);
 assert.deepEqual((await auth.state.keys.get('session',['peer'])).peer,Buffer.from('old'));
 await admin.configSet('min-replicas-to-write','0');await auth.saveCreds();await auth.state.keys.set({session:{peer:Buffer.from('new')}});
 const restored=await useMultiFileAuthStateRedisDb(instance,cache);assert.equal(restored.state.creds.registered,true);
 assert.deepEqual((await restored.state.keys.get('session',['peer'])).peer,Buffer.from('new'));
});
test('failed key and credential deletion cannot be reported as successful cleanup',async()=>{
 const auth=await useMultiFileAuthStateRedisDb(instance,cache);await auth.saveCreds();await auth.state.keys.set({session:{peer:Buffer.from('retained')}});
 await rejectWrites();await assert.rejects(auth.state.keys.set({session:{peer:null}}),/NOREPLICAS/);await assert.rejects(auth.removeCreds(),/NOREPLICAS/);
 assert.equal(await admin.exists(key),1);
 await admin.configSet('min-replicas-to-write','0');await auth.removeCreds();assert.equal(await admin.exists(key),0);
});
test('ordinary non-persistent caches retain their best-effort behavior',async()=>{
 const ordinary=new CacheService(new CacheEngine(configService,'instance').getEngine());await admin.set(key,'wrong-type');
 assert.equal(await ordinary.hGet(instance,'creds'),null);
 await ordinary.hSet(instance,'creds',{synthetic:true});
});

test('the installed SDK never exposes an uncommitted Redis session key',async()=>{
 const { makeCacheableSignalKeyStore }=await import('baileys');
 const auth=await useMultiFileAuthStateRedisDb(instance,cache);
 const cached=makeCacheableSignalKeyStore(auth.state.keys);
 const original=Buffer.from('committed');await cached.set({session:{peer:original}});
 await rejectWrites();await assert.rejects(cached.set({session:{peer:Buffer.from('uncommitted')}}),/NOREPLICAS/);
 assert.deepEqual((await cached.get('session',['peer'])).peer,original);
 assert.deepEqual((await auth.state.keys.get('session',['peer'])).peer,original);
 await admin.configSet('min-replicas-to-write','0');await cached.set({session:{peer:Buffer.from('retry')}});
 assert.deepEqual((await cached.get('session',['peer'])).peer,Buffer.from('retry'));
});

test('persistent mode rejects a missing Redis configuration instead of selecting a local cache',()=>{
 const config={get:()=>({REDIS:{ENABLED:true,URI:''},LOCAL:{ENABLED:true}})};
 assert.throws(()=>new CacheEngine(config,'instance','throw'),/requires a Redis URI/);
 assert.throws(()=>new CacheService(undefined,'throw'),/not configured/);
});
test('persistent scalar writes also propagate the rejected Redis command',async()=>{
 await rejectWrites();await assert.rejects(cache.set('synthetic-scalar',{value:1}),/NOREPLICAS/);
});
