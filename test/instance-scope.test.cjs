const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const express = require('express');
require('express-async-errors');

class HttpError extends Error {
  constructor(message = 'Unauthorized') { super(message); this.status = message === 'Unauthorized' ? 401 : 400; }
}
const fixtures = [
  { id: 'synthetic-a-id', name: 'synthetic-a', token: 'synthetic-a-key' },
  { id: 'synthetic-b-id', name: 'synthetic-b', token: 'synthetic-b-key' },
];
const configService = { get: name => name === 'AUTHENTICATION' ? { API_KEY: { KEY: 'synthetic-global-key' } } : { SAVE_DATA: { INSTANCE: true } } };
const store = { instance: {
  findUnique: async ({where}) => fixtures.find(item => item.name === where.name),
  findFirst: async ({where}) => fixtures.find(item => item.token === where.token),
} };
const selectedFilters = [];
const controller = {
  createInstance: async data => ({ createdName: data.instanceName, qrcode: data.qrcode }),
  fetchInstances: async (filters, key) => {
    selectedFilters.push(filters);
    return fixtures.filter(item => (key === 'synthetic-global-key' || item.token === key) &&
      (!filters.instanceName || item.name === filters.instanceName) && (!filters.instanceId || item.id === filters.instanceId) &&
      (!filters.number || item.name === filters.number)).map(item => ({ name: item.name, id: item.id }));
  },
};
const modules = new Map();
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const filename = path.resolve(relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename,'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === '@api/server.module') return { prismaRepository: store, instanceController: controller };
    if (name === '@config/env.config') return { configService };
    if (name === '@config/logger.config') return { Logger: class { warn() {} error() {} } };
    if (name === '@exceptions') return { UnauthorizedException: HttpError, ForbiddenException: HttpError, BadRequestException: HttpError };
    if (name === '@api/abstract/abstract.router') return load('src/api/abstract/abstract.router.ts');
    if (name === '@api/dto/instance.dto') return { InstanceDto: class {}, SetPresenceDto: class {} };
    if (name === '@validate/validate.schema') return { instanceSchema: {type:'object',properties:{instanceName:{type:'string'}},required:['instanceName']}, presenceOnlySchema:{} };
    if (name === './index.router') return { HttpStatus: { OK:200,CREATED:201 } };
    return require(name);
  } }, { filename });
  modules.set(relative, exports);
  return exports;
}
let server,base;
before(async () => {
  const { authGuard } = load('src/api/guards/auth.guard.ts');
  const { RouterBroker } = load('src/api/abstract/abstract.router.ts');
  const { InstanceRouter } = load('src/api/routes/instance.router.ts');
  const app = express();app.use(express.json());
  app.get('/scope/:instanceName',authGuard.apikey,async (req,res) => {
    const result = await new RouterBroker().dataValidate({request:req,schema:null,ClassRef:class{},execute:async (instance,data)=>({
      instanceName:instance.instanceName,instanceId:instance.instanceId ?? null,number:instance.number ?? null,
    })});res.json(result);
  });
  app.use('/instance',new InstanceRouter(configService,authGuard.apikey).router);
  app.use((error,_req,res,_next)=>res.status(error.status ?? 500).json({error:error.message}));
  await new Promise(resolve => { server=app.listen(0,'127.0.0.1',resolve); });
  base='http://127.0.0.1:'+server.address().port;
});
after(async () => { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); });
async function request(url,key='synthetic-a-key',body) {
  const headers = { 'Content-Type':'application/json' };if(key)headers.apikey=key;
  const response=await fetch(base+url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}

test('validates the route owner and rejects a key for another instance',async()=>{
  assert.equal((await request('/scope/synthetic-a')).status,200);
  assert.equal((await request('/scope/synthetic-b')).status,401);
  assert.equal((await request('/scope/synthetic-a',null)).status,401);
  assert.equal((await request('/scope/synthetic-a','synthetic-invalid-key')).status,401);
});
test('query parameters cannot replace the authenticated instance name or ID',async()=>{
  const result=await request('/scope/synthetic-a?instanceName=synthetic-b&instanceId=synthetic-b-id');
  assert.equal(result.status,200);
  assert.deepEqual(result.body,{instanceName:'synthetic-a',instanceId:null,number:null});
});
test('retains legitimate unprotected query options',async()=>{
  const result=await request('/scope/synthetic-a?number=synthetic-option');
  assert.equal(result.body.number,'synthetic-option');
});
test('global-key instance creation still uses the validated body name and options',async()=>{
  const result=await request('/instance/create','synthetic-global-key',{instanceName:'synthetic-new',qrcode:false});
  assert.equal(result.status,201);
  assert.deepEqual(result.body,{createdName:'synthetic-new',qrcode:false});
  assert.equal((await request('/instance/create','synthetic-global-key',{qrcode:false})).status,400);
  assert.equal((await request('/instance/create','synthetic-a-key',{instanceName:'synthetic-new'})).status,401);
});
test('query input cannot replace the instance name in the creation body',async()=>{
  const result=await request('/instance/create?instanceName=synthetic-query','synthetic-global-key',{instanceName:'synthetic-body',qrcode:false});
  assert.equal(result.status,201);
  assert.equal(result.body.createdName,'synthetic-body');
});
test('global listing keeps its name, ID and number filters',async()=>{
  for(const filter of ['instanceName=synthetic-b','instanceId=synthetic-b-id','number=synthetic-b']){
    const result=await request('/instance/fetchInstances?'+filter,'synthetic-global-key');
    assert.equal(result.status,200);assert.deepEqual(result.body,[{name:'synthetic-b',id:'synthetic-b-id'}]);
  }
});
test('listing filters cannot expose another instance with a delegated key',async()=>{
  const own=await request('/instance/fetchInstances?instanceName=synthetic-a');
  assert.deepEqual(own.body,[{name:'synthetic-a',id:'synthetic-a-id'}]);
  const foreign=await request('/instance/fetchInstances?instanceName=synthetic-b');
  assert.equal(foreign.body.some(item=>item.name==='synthetic-b'),false);
});
test('listing rejects non-string filter values instead of broadening the selection',async()=>{
  const result=await request('/instance/fetchInstances?instanceName[]=synthetic-b','synthetic-global-key');
  assert.equal(result.status,400);
});
