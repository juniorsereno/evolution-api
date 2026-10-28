const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_auth_scope_test') {
  throw Error('Run only inside the disposable evolution_auth_scope_test API container.');
}
const base = 'http://127.0.0.1:8080';
const globalKey = process.env.AUTHENTICATION_API_KEY;
const names = ['synthetic-scope-a','synthetic-scope-b','synthetic-scope-created'];
const keys = ['synthetic-scope-a-key','synthetic-scope-b-key'];
let ids;
async function request(path,key=globalKey,body,method=body?'POST':'GET') {
  const headers = {'Content-Type':'application/json'};if(key)headers.apikey=key;
  const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}
before(async()=>{
  for(let attempt=0;attempt<50;attempt++){
    try { if((await request('/instance/fetchInstances')).status===200)break; }catch{}
    if(attempt===49)throw Error('Disposable API did not become ready');
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  for(let i=0;i<2;i++) {
    const created=await request('/instance/create',globalKey,{instanceName:names[i],integration:'WHATSAPP-BAILEYS',qrcode:false,token:keys[i]});
    assert.equal(created.status,201);
    const settings=await request('/settings/set/'+names[i],keys[i],{rejectCall:false,msgCall:'marker-'+i,groupsIgnore:true,alwaysOnline:false,readMessages:false,readStatus:false,syncFullHistory:false});
    assert.equal(settings.status,201);
  }
  const all=await request('/instance/fetchInstances');
  ids=names.slice(0,2).map(name=>all.body.find(item=>item.name===name).id);
});
after(async()=>{
  for(const name of names){
    const result=await request('/instance/delete/'+name,globalKey,undefined,'DELETE');
    assert.ok([200,404].includes(result.status));
  }
});
test('runtime accepts own key and rejects a foreign or missing key',async()=>{
  assert.equal((await request('/settings/find/'+names[0],keys[0])).status,200);
  assert.equal((await request('/settings/find/'+names[1],keys[0])).status,401);
  assert.equal((await request('/settings/find/'+names[0],null)).status,401);
});
test('runtime does not redirect an authenticated request to another instance through query fields',async()=>{
  const response=await request('/settings/find/'+names[0]+'?instanceName='+names[1]+'&instanceId='+ids[1],keys[0]);
  assert.equal(response.status,200);assert.equal(response.body.msgCall,'marker-0');
});
test('runtime retains global listing filters and token-scoped listing restrictions',async()=>{
  for(const filter of ['instanceName='+names[1],'instanceId='+ids[1]]){
    const response=await request('/instance/fetchInstances?'+filter);
    assert.equal(response.status,200);assert.deepEqual(response.body.map(item=>item.name),[names[1]]);
  }
  assert.equal((await request('/instance/fetchInstances?instanceName='+names[1],keys[0])).status,401);
});
test('runtime creates from the validated body while ignoring an alternate query name',async()=>{
  const response=await request('/instance/create?instanceName=synthetic-query-only',globalKey,{instanceName:names[2],integration:'WHATSAPP-BAILEYS',qrcode:false});
  assert.equal(response.status,201);assert.equal(response.body.instance.instanceName,names[2]);
});
test('runtime rejects a structured listing filter',async()=>{
  assert.equal((await request('/instance/fetchInstances?instanceName[]='+names[1])).status,400);
});
