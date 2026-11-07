const assert=require('node:assert/strict');
const {test}=require('node:test');
const {CredentialPersistence}=require('../dist/utils/credential-persistence');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('concurrent credential changes serialize writes and finish with the latest value',async()=>{
 const entered=deferred(),release=deferred();let value=1,active=0,maxActive=0;const saved=[];
 const writer=new CredentialPersistence(async()=>{active++;maxActive=Math.max(maxActive,active);const snapshot=value;if(saved.length===0){entered.resolve();await release.promise;}saved.push(snapshot);active--;},()=>assert.fail('unexpected failure'));
 const a=writer.request();await entered.promise;value=2;const b=writer.request();value=3;const c=writer.request();release.resolve();await Promise.all([a,b,c]);await writer.stop();
 assert.deepEqual(saved,[1,3]);assert.equal(maxActive,1);
});
test('stop cancels pending retries and waits for an already running write',async()=>{
 const entered=deferred(),release=deferred();let calls=0,stopped=false;
 const writer=new CredentialPersistence(async()=>{calls++;entered.resolve();await release.promise;throw Error('synthetic write failure');},()=>{});
 const writing=writer.request();await entered.promise;const stopping=writer.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
 release.resolve();await Promise.all([writing,stopping]);await writer.request();await new Promise(r=>setTimeout(r,1100));assert.equal(calls,1);
});
test('a failed save retries the current credentials without another request',async()=>{
 let value=1,calls=0,saved;const errors=[];
 const writer=new CredentialPersistence(async()=>{if(++calls===1)throw Error('synthetic outage');saved=value;},e=>errors.push(e));
 try{await writer.request();value=2;await new Promise(r=>setTimeout(r,1150));assert.equal(calls,2);assert.equal(saved,2);assert.equal(errors.length,1);}finally{await writer.stop();}
});
