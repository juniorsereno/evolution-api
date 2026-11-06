const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const http = require('node:http');
const { PrismaClient } = require('@prisma/client');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') throw Error('Disposable database required');
const prisma = new PrismaClient();
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { configService } = require('../dist/config/env.config');
const phone = '5511999999999@s.whatsapp.net', lid = '1234567890123456@lid';
const instance = { instanceName: 'synthetic-lid', instanceId: 'synthetic-lid-id' };
const requests = [], services = [];
let server, base;
before(async () => {
  await prisma.instance.create({data:{id:instance.instanceId,name:instance.instanceName}});
  server = http.createServer(async (req, res) => {
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body = req.headers['content-type']?.startsWith('multipart/form-data')
      ? Object.fromEntries([...raw.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map(match => [match[1], match[2]]))
      : raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    const contact = { id: 17, identifier: phone, phone_number: '+5511999999999', name: 'Synthetic peer', thumbnail: '' };
    let response;
    if (req.url.includes('/contacts/search?')) response = { payload: [{...contact,identifier:'123456@g.us'}] };
    else if (req.url.endsWith('/contacts/filter')) response = { payload: [contact] };
    else if (req.url.endsWith('/inboxes')) response = { payload: [{ id: 30, name: 'Synthetic' }] };
    else if (req.url.endsWith('/contacts/17/conversations')) response = { payload: [{ id: 42, inbox_id: 30, status: 'open' }] };
    else if (req.url.endsWith('/conversations/42/messages')) response = { id: 99, inbox_id: 30, conversation_id: 42 };
    else if (req.url.endsWith('/conversations/42')) response = { id: 42, inbox_id: 30, meta: { sender: contact } };
    else { res.writeHead(500); res.end(JSON.stringify({ error: 'Unexpected synthetic request' })); return; }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await services[0]?.pgClient.end(); await prisma.instance.delete({where:{id:instance.instanceId}}); await prisma.$disconnect(); });
function subject(resolve = async () => phone) {
  const data = new Map();
  const cache = { has: async key=>data.has(key), get: async key=>data.get(key), set: async (key,value)=>{data.set(key,value)}, delete: async key=>{data.delete(key)} };
  const provider = { enabled:true, accountId:'6', token:'synthetic-token', url:base, nameInbox:'Synthetic', reopenConversation:false };
  const channel = { instanceId: instance.instanceId, findChatwoot: async()=>provider, profilePicture: async()=>({ profilePictureUrl:null }), client:{ groupMetadata:async()=>({subject:'Synthetic group'}), signalRepository:{ lidMapping:{ getPNForLID:resolve } } } };
  const repository = prisma;
  const config = { get(name) { const value=configService.get(name); return name==='CHATWOOT' ? {...value, IMPORT:{...value.IMPORT, DATABASE:{CONNECTION:{URI:''}}}} : value; } };
  const s=new ChatwootService({ waInstances:{[instance.instanceName]:channel} },config,repository,cache);
  services.push(s); return { s, provider, channel, repository };
}
function message(jid, fromMe=false, alternate) {
  return { key: { id:'synthetic-'+jid+'-'+fromMe, remoteJid:jid, fromMe, addressingMode:'lid', ...(alternate ? {remoteJidAlt:alternate}: {}) }, message:{conversation:'Synthetic content'}, pushName:'Synthetic peer' };
}
test('live inbound and phone-originated messages with only LID reach the existing phone conversation', async()=>{
  for (const fromMe of [false,true]) {
    const {s}=subject();
    const body=message(lid,fromMe); const before=structuredClone(body);
    const sent=await s.eventWhatsapp('messages.upsert',instance,body);
    assert.equal(sent?.conversation_id,42);
    const delivered=requests.filter(r=>r.url.endsWith('/messages')).at(-1);
    assert.equal(delivered.body.message_type,fromMe?'outgoing':'incoming');
    assert.deepEqual(body,before);
  }
});

test('PN, LID plus alternate, and LID-only all reuse the same existing conversation without modifying the contact', async()=>{
  const {s}=subject(); const start=requests.length;
  for(const body of [message(phone+''),message(lid,false,phone),message(lid),message('5511999999999:3@s.whatsapp.net')]) {
    assert.equal(await s.createConversation(instance,body),42);
  }
  const calls=requests.slice(start);
  assert.equal(calls.filter(r=>r.url.endsWith('/contacts/17/conversations')).length,1);
  assert.equal(calls.filter(r=>r.method==='PUT'||r.method==='PATCH'||r.url.endsWith('/contact_merge')).length,0);
  assert.equal(calls.filter(r=>r.url.endsWith('/contacts')||r.url.endsWith('/conversations')).length,1);
});
test('an authoritative alternate or phone JID does not depend on the mapping store', async()=>{
  const {s}=subject(async()=>{throw Error('Mapping must not be queried');});
  assert.equal(await s.createConversation(instance,message(lid,false,phone)),42);
  assert.equal(await s.createConversation(instance,message(phone)),42);
});
test('unknown LID stays persisted without sending to a fabricated phone; replay succeeds when mapping arrives', async()=>{
  const unknown='777777777777777@lid'; let mapped=null;
  const {s}=subject(async()=>mapped);
  const body=message(unknown); const stored=await prisma.message.create({data:{key:body.key,message:body.message,messageTimestamp:1700000000,messageType:'conversation',source:'web',instanceId:instance.instanceId}});
  const start=requests.length;
  assert.equal(await s.eventWhatsapp('messages.upsert',instance,body),null);
  assert.equal(requests.length,start);
  assert.deepEqual((await prisma.message.findUnique({where:{id:stored.id}})).key,body.key);
  mapped=phone;
  assert.equal((await s.eventWhatsapp('messages.upsert',instance,body)).conversation_id,42);
  await prisma.message.delete({where:{id:stored.id}});
});
test('uses prior verified associations from this instance when the SDK mapping is absent, in either direction', async()=>{
  for (const key of [{remoteJid:lid,remoteJidAlt:phone},{remoteJid:phone,remoteJidAlt:lid}]) {
    const stored=await prisma.message.create({data:{key:{...key,id:'known-pair',fromMe:false},message:{conversation:'Synthetic earlier message'},messageTimestamp:1700000000,messageType:'conversation',source:'web',instanceId:instance.instanceId}});
    const {s}=subject(async()=>null);
    assert.equal(await s.createConversation(instance,message(lid)),42);
    await prisma.message.delete({where:{id:stored.id}});
  }
});
test('cannot borrow another instance mapping or treat a group alternate as a phone', async()=>{
  const foreign=await prisma.instance.create({data:{name:'synthetic-foreign-lid'}});
  try {
    await prisma.message.create({data:{key:{id:'foreign-pair',remoteJid:lid,remoteJidAlt:phone,fromMe:false},message:{conversation:'Synthetic foreign'},messageTimestamp:1700000000,messageType:'conversation',source:'web',instanceId:foreign.id}});
    const {s}=subject(async()=> '123456@g.us'); const start=requests.length;
    assert.equal(await s.createConversation(instance,message(lid,false,'123456@g.us')),null);
    assert.equal(requests.length,start);
  } finally {await prisma.instance.delete({where:{id:foreign.id}});}
});
test('ignore rules apply to canonical phones and original LIDs', async()=>{
  for(const ignore of ['@s.whatsapp.net',phone,lid]) {
    const {s,provider}=subject(); provider.ignoreJids=[ignore]; const start=requests.length;
    assert.equal(await s.eventWhatsapp('messages.upsert',instance,message(lid)),undefined);
    assert.equal(requests.length,start);
  }
});

test('group identity stays on the group even when it includes a phone alternate', async()=>{
  const {s}=subject(async()=>{throw Error('No direct mapping for groups');});
  const body=message('123456@g.us',true,phone); body.key.participant=phone;
  assert.equal(await s.createConversation(instance,body),42);
  assert.ok(requests.some(r=>r.url.includes('/contacts/search?')&&decodeURIComponent(r.url).includes('123456@g.us')));
});
test('a known Vartana-origin echo keeps its original author link even without a phone mapping', async()=>{
  const body=message('888888888888888@lid',true);
  await prisma.messageOrigin.create({data:{instanceId:instance.instanceId,messageId:body.key.id,origin:'chatwoot',chatwootAccountId:'6',chatwootMessageId:901,chatwootInboxId:30,chatwootConversationId:42}});
  const {s}=subject(async()=>{throw Error('Origin already identifies this echo');});const start=requests.length;
  assert.deepEqual(await s.eventWhatsapp('messages.upsert',instance,body),{id:901,inbox_id:30,conversation_id:42});
  assert.equal(requests.length,start);
});
