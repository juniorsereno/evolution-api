const assert=require('node:assert/strict');
const {test,before,after,beforeEach,afterEach,mock}=require('node:test');
const {PrismaClient}=require('@prisma/client');
const redis=require('redis'),Module=require('node:module');
const uri=process.env.AUTH_TEST_REDIS_URI;
if(!uri||!['127.0.0.1','evolution-auth-redis'].includes(new URL(uri).hostname))throw Error('Task Redis required');
if(new URL(process.env.DATABASE_CONNECTION_URI).pathname!='/evolution_runtime_test')throw Error('Disposable DB required');
Object.assign(process.env,{CACHE_REDIS_ENABLED:'true',CACHE_REDIS_SAVE_INSTANCES:'false',CACHE_REDIS_URI:uri,CACHE_REDIS_PREFIX_KEY:'synthetic-hybrid',CACHE_LOCAL_ENABLED:'false',DATABASE_SAVE_DATA_INSTANCE:'true'});
const clients=[],databases=[];
let prisma,admin,authAdapter,cache,instance,Monitor;
const originalCreate=redis.createClient;
mock.method(redis,'createClient',(...args)=>{const c=originalCreate(...args);clients.push(c);return c;});
before(async()=>{
 await import('baileys');
 const load=Module._load;
 const patch=mock.method(Module,'_load',function(name,...args){const m=load.call(this,name,...args);if(name==='@prisma/client')return {...m,PrismaClient:class extends m.PrismaClient{constructor(...a){super(...a);databases.push(this)}}};return m;});
 try{authAdapter=require('../dist/utils/use-multi-file-auth-state-prisma').default;cache=require('../dist/api/server.module').cache;Monitor=require('../dist/api/server.module').waMonitor.constructor;}finally{patch.mock.restore();}
 prisma=new PrismaClient();admin=redis.createClient({url:uri});await admin.connect();
 await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION synthetic_reject_auth() RETURNS trigger AS $$ BEGIN IF NEW."sessionId" = 'synthetic-hybrid-blocked' THEN RAISE EXCEPTION 'synthetic credential write rejected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
 await prisma.$executeRawUnsafe(`CREATE TRIGGER synthetic_reject_auth BEFORE INSERT OR UPDATE ON "Session" FOR EACH ROW EXECUTE FUNCTION synthetic_reject_auth()`);
});
beforeEach(async()=>{instance=await prisma.instance.create({data:{name:'synthetic-hybrid-'+Date.now()}});});
afterEach(async()=>{await admin.configSet('min-replicas-to-write','0');await admin.del('synthetic-hybrid:instance:'+instance.id);await prisma.instance.delete({where:{id:instance.id}});});
after(async()=>{
 await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_reject_auth ON "Session"');await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS synthetic_reject_auth()');
 await prisma.instance.deleteMany({where:{id:'synthetic-hybrid-blocked'}});
 await Promise.all(databases.map(p=>p.$disconnect()));await prisma.$disconnect();await Promise.all(clients.filter(c=>c.isOpen).map(c=>c.quit()));mock.restoreAll();
});
test('existing double encoded credentials and binary Redis keys survive reload',async()=>{
 const a=await authAdapter(instance.id,cache);a.state.creds.registered=true;await a.saveCreds();await a.state.keys.set({session:{peer:Buffer.from('committed')}});
 const b=await authAdapter(instance.id,cache);assert.equal(b.state.creds.registered,true);assert.deepEqual((await b.state.keys.get('session',['peer'])).peer,Buffer.from('committed'));
});
test('corrupt persisted credentials reject instead of replacing the identity',async()=>{
 await prisma.session.create({data:{sessionId:instance.id,creds:'invalid-json'}});
 await assert.rejects(authAdapter(instance.id,cache));assert.equal((await prisma.session.findUnique({where:{sessionId:instance.id}})).creds,'invalid-json');
});
test('failed PostgreSQL credential creation rejects initialization',async()=>{
 await prisma.instance.create({data:{id:'synthetic-hybrid-blocked',name:'synthetic-hybrid-blocked'}});
 await assert.rejects(authAdapter('synthetic-hybrid-blocked',cache),/synthetic credential write rejected/);
 await prisma.$executeRawUnsafe('ALTER TABLE "Session" DISABLE TRIGGER synthetic_reject_auth');
 let a;
 try{a=await authAdapter('synthetic-hybrid-blocked',cache);}finally{await prisma.$executeRawUnsafe('ALTER TABLE "Session" ENABLE TRIGGER synthetic_reject_auth');}
 const original=(await prisma.session.findUnique({where:{sessionId:'synthetic-hybrid-blocked'}})).creds;
 a.state.creds.registered=true;await assert.rejects(a.saveCreds(),/synthetic credential write rejected/);
 assert.equal((await prisma.session.findUnique({where:{sessionId:'synthetic-hybrid-blocked'}})).creds,original);
 await prisma.$executeRawUnsafe('ALTER TABLE "Session" DISABLE TRIGGER synthetic_reject_auth');
 try{await a.saveCreds();assert.equal((await authAdapter('synthetic-hybrid-blocked',cache)).state.creds.registered,true);}finally{await prisma.$executeRawUnsafe('ALTER TABLE "Session" ENABLE TRIGGER synthetic_reject_auth');}
});
test('Redis WRONGTYPE read rejects rather than returning a missing key',async()=>{
 const a=await authAdapter(instance.id,cache);await admin.set('synthetic-hybrid:instance:'+instance.id,'wrong-type');await assert.rejects(a.state.keys.get('session',['peer']),/WRONGTYPE/);
});
test('failed Redis key persistence rejects and keeps committed keys',async()=>{
 const a=await authAdapter(instance.id,cache);await a.state.keys.set({session:{peer:Buffer.from('old')}});await admin.configSet('min-replicas-to-write','1');
 await assert.rejects(a.state.keys.set({session:{peer:Buffer.from('new')}}),/NOREPLICAS/);assert.deepEqual((await a.state.keys.get('session',['peer'])).peer,Buffer.from('old'));
});
test('an unserializable key cannot partially commit its batch',async()=>{
 const a=await authAdapter(instance.id,cache);const cycle={};cycle.self=cycle;
 await assert.rejects(a.state.keys.set({session:{first:Buffer.from('uncommitted'),second:cycle}}));await admin.ping();
 assert.equal((await a.state.keys.get('session',['first'])).first,null);
});

test('mixed key writes and deletions preserve other instances and the existing hash format',async()=>{
 const a=await authAdapter(instance.id,cache);const other=await prisma.instance.create({data:{name:'synthetic-other-'+Date.now()}});
 try{
  const b=await authAdapter(other.id,cache);await b.state.keys.set({session:{peer:Buffer.from('other-tenant')}});
  await a.state.keys.set({session:{peer:Buffer.from('old'),remove:Buffer.from('delete-me')}});
  await a.state.keys.set({session:{peer:Buffer.from('new'),remove:null},'app-state-sync-key':{sync:{keyData:Buffer.from('sync')}}});
  const reload=await authAdapter(instance.id,cache);assert.deepEqual((await reload.state.keys.get('session',['peer','remove'])),{peer:Buffer.from('new'),remove:null});
  assert.deepEqual((await reload.state.keys.get('app-state-sync-key',['sync'])).sync.keyData,Buffer.from('sync'));
  assert.deepEqual((await b.state.keys.get('session',['peer'])).peer,Buffer.from('other-tenant'));
  assert.equal(typeof JSON.parse(await admin.hGet('synthetic-hybrid:instance:'+instance.id,'session-peer')),'string');
 }finally{await admin.del('synthetic-hybrid:instance:'+other.id);await prisma.instance.delete({where:{id:other.id}});}
});
test('rejected atomic batch leaves all original keys intact and succeeds after recovery',async()=>{
 const a=await authAdapter(instance.id,cache);await a.state.keys.set({session:{keep:Buffer.from('old'),remove:Buffer.from('retained')}});
 const changes={session:{keep:Buffer.from('new'),remove:null,added:Buffer.from('added')}};
 await admin.configSet('min-replicas-to-write','1');await assert.rejects(a.state.keys.set(changes),/NOREPLICAS/);
 assert.deepEqual(await a.state.keys.get('session',['keep','remove','added']),{keep:Buffer.from('old'),remove:Buffer.from('retained'),added:null});
 await admin.configSet('min-replicas-to-write','0');await a.state.keys.set(changes);
 assert.deepEqual(await a.state.keys.get('session',['keep','remove','added']),{keep:Buffer.from('new'),remove:null,added:Buffer.from('added')});
});
test('logout deletion failure is observable and does not remove PostgreSQL credentials first',async()=>{
 const a=await authAdapter(instance.id,cache);await a.state.keys.set({session:{peer:Buffer.from('old')}});
 await admin.configSet('min-replicas-to-write','1');await assert.rejects(a.removeCreds(),/NOREPLICAS/);
 assert.equal(await prisma.session.count({where:{sessionId:instance.id}}),1);
 await admin.configSet('min-replicas-to-write','0');await a.removeCreds();await a.removeCreds();
 assert.equal(await prisma.session.count({where:{sessionId:instance.id}}),0);assert.equal(await admin.exists('synthetic-hybrid:instance:'+instance.id),0);
});

test('PostgreSQL read failure rejects initialization and preserves the stored identity',async()=>{
 const a=await authAdapter(instance.id,cache);const original=(await prisma.session.findUnique({where:{sessionId:instance.id}})).creds;
 await prisma.$executeRawUnsafe('ALTER TABLE "Session" RENAME TO "SyntheticSessionHidden"');
 try{await assert.rejects(authAdapter(instance.id,cache),e=>e.code==='P2021');}finally{await prisma.$executeRawUnsafe('ALTER TABLE "SyntheticSessionHidden" RENAME TO "Session"');}
 assert.equal((await prisma.session.findUnique({where:{sessionId:instance.id}})).creds,original);
});

test('terminal logout cleanup removes hybrid Redis keys as well as PostgreSQL credentials',async()=>{
 const a=await authAdapter(instance.id,cache);await a.state.keys.set({session:{peer:Buffer.from('old-session')}});
 const {configService}=require('../dist/config/env.config');const Emitter=require('eventemitter2');
 const monitor=new Monitor(new Emitter(),configService,prisma,null,cache,cache,cache);
 await monitor.cleaningUp(instance.name);
 assert.equal(await prisma.session.count({where:{sessionId:instance.id}}),0);assert.equal(await admin.exists('synthetic-hybrid:instance:'+instance.id),0);
});

test('SDK record transactions preserve session ordering through the hybrid Redis adapter',async()=>{
 const sdk=await import('baileys'),logger=require('pino')({level:'silent'});
 const a=await authAdapter(instance.id,cache);
 const keys=sdk.addTransactionCapability(sdk.makeCacheableSignalKeyStore(a.state.keys,logger),logger,{maxCommitRetries:1,delayBetweenTriesMs:0});
 let signal,release;const ready=new Promise(r=>{signal=r}),finish=new Promise(r=>{release=r});
 const first=keys.transaction(async()=>{
  await keys.transactWith({records:[{type:'session',id:'peer'}]},async()=>keys.set({session:{peer:Buffer.from('first')}}));
  signal();await finish;
 },'outbound');
 await ready;
 const second=keys.transactWith({records:[{type:'session',id:'peer'}]},async()=>keys.set({session:{peer:Buffer.from('second')}}));
 await new Promise(r=>setImmediate(r));
 const before=(await a.state.keys.get('session',['peer'])).peer;
 release();await Promise.all([first,second]);assert.equal(before,null);
 const reload=await authAdapter(instance.id,cache);assert.deepEqual((await reload.state.keys.get('session',['peer'])).peer,Buffer.from('second'));
});
test('SDK failed identity/session commits leave both persisted values intact and release their locks',async()=>{
 const sdk=await import('baileys'),logger=require('pino')({level:'silent'});
 const a=await authAdapter(instance.id,cache);
 const keys=sdk.addTransactionCapability(sdk.makeCacheableSignalKeyStore(a.state.keys,logger),logger,{maxCommitRetries:1,delayBetweenTriesMs:0});
 await keys.set({session:{peer:Buffer.from('old')},'identity-key':{peer:Buffer.from('old-identity')}});
 const scope={records:[{type:'session',id:'peer'},{type:'identity-key',id:'peer'}]};
 const replace=()=>keys.transactWith(scope,async()=>keys.set({session:{peer:null},'identity-key':{peer:Buffer.from('new-identity')}}));
 await admin.configSet('min-replicas-to-write','1');
 try{await assert.rejects(replace(),/NOREPLICAS/);}finally{await admin.configSet('min-replicas-to-write','0');}
 const reload=await authAdapter(instance.id,cache);
 assert.deepEqual((await reload.state.keys.get('session',['peer'])).peer,Buffer.from('old'));
 assert.deepEqual((await reload.state.keys.get('identity-key',['peer'])).peer,Buffer.from('old-identity'));
 await replace();assert.equal((await reload.state.keys.get('session',['peer'])).peer,null);
 assert.deepEqual((await reload.state.keys.get('identity-key',['peer'])).peer,Buffer.from('new-identity'));
});
