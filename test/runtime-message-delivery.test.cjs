const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const http = require('node:http');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test' ||
    new URL(process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI).pathname !== '/evolution_import_test') throw Error('Disposable databases required');
process.env.DATABASE_SAVE_DATA_NEW_MESSAGE = 'true';
const { ChatwootService } = require((process.env.EVOLUTION_TEST_DIST || '../dist') + '/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { BaileysStartupService } = require((process.env.EVOLUTION_TEST_DIST || '../dist') + '/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const app = new Pool({connectionString:process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI});
const phone='5511999999999@s.whatsapp.net', lid='1234567890123456@lid';
const services=[], receivers=[];
let instance, server, provider, mapped, failHttp, posts, attachmentSeen;
const cache=()=>{const data=new Map(); return {has:async k=>data.has(k),get:async k=>data.get(k),set:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};};
before(async()=>{
 instance=await prisma.instance.create({data:{name:'synthetic-delivery'}});
 server=http.createServer(async(req,res)=>{
  let raw=''; for await(const chunk of req) raw+=chunk;
  const body=req.headers['content-type']?.startsWith('multipart/form-data')
   ? Object.fromEntries([...raw.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map(m=>[m[1],m[2]])) : raw?JSON.parse(raw):{};
  const contact={id:17,identifier:phone,phone_number:'+5511999999999',name:'Synthetic',thumbnail:''};
  attachmentSeen ||= raw.includes('Synthetic attachment');
  let response;
  if(req.url.endsWith('/contacts/filter'))response={payload:[contact]};
  else if(req.url.endsWith('/inboxes'))response={payload:[{id:30,name:'Synthetic'}]};
  else if(req.url.endsWith('/contacts/17/conversations'))response={payload:[{id:42,inbox_id:30,status:'open'}]};
  else if(req.url.endsWith('/conversations/42/messages')){
   posts++;
   if(failHttp){res.writeHead(503);res.end('{}');return;}
   const saved=await app.query(`INSERT INTO messages(account_id,inbox_id,conversation_id,content,source_id,message_type,created_at,updated_at)
    VALUES(6,30,42,$1,$2,0,NOW(),NOW()) RETURNING id`,[body.content,body.source_id]);
   response={id:saved.rows[0].id,inbox_id:30,conversation_id:42};
  } else if(req.url.endsWith('/conversations/42'))response={id:42,inbox_id:30,meta:{sender:contact}};
  else {res.writeHead(500);res.end('{}');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 provider={enabled:true,accountId:'6',token:'synthetic',url:'http://127.0.0.1:'+server.address().port,nameInbox:'Synthetic',reopenConversation:false};
 await app.query(`TRUNCATE accounts,inboxes,messages,conversations,contacts,contact_inboxes CASCADE;
 INSERT INTO accounts(id,name,created_at,updated_at) VALUES(6,'Synthetic',NOW(),NOW());
 INSERT INTO inboxes(id,account_id,name,channel_type,channel_id,created_at,updated_at) VALUES(30,6,'Synthetic','Channel::Api',1,NOW(),NOW());
 INSERT INTO conversations(id,display_id,account_id,inbox_id,status,created_at,updated_at) VALUES(42,42,6,30,0,NOW(),NOW());
 UPDATE conversations SET display_id=42 WHERE id=42;`);
});
beforeEach(async()=>{mapped=phone;failHttp=false;posts=0;attachmentSeen=false;await prisma.message.deleteMany({where:{instanceId:instance.id}});await app.query('DELETE FROM messages');});
after(async()=>{
 for(const r of receivers)r.messageProcessor.onDestroy();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await services[0]?.pgClient.end();await app.end();await prisma.instance.delete({where:{id:instance.id}});await prisma.$disconnect();
});
function subject(){
 const channel={instanceId:instance.id,findChatwoot:async()=>provider,profilePicture:async()=>({profilePictureUrl:null}),getBase64FromMediaMessage:async()=>({base64:Buffer.from('Synthetic attachment').toString('base64'),mimetype:'text/plain'}),client:{signalRepository:{lidMapping:{getPNForLID:async()=>mapped}}}};
 const service=new ChatwootService({waInstances:{[instance.name]:channel}},configService,prisma,cache());services.push(service);return service;
}
const scope=()=>({instanceName:instance.name,instanceId:instance.id});
function data(id,remoteJid=lid){return {instanceId:instance.id,key:{id,remoteJid,fromMe:false},message:{conversation:'Synthetic'},messageTimestamp:1700000000,messageType:'conversation',source:'web'};}
async function pending(service,id,jid){return prisma.message.create({data:{...data(id,jid),chatwootDeliveryPending:true,chatwootDeliveryTarget:service.deliveryTarget(provider)}});}
test('pending LID survives restart and more than six hours, then delivers exactly once after mapping arrives',async()=>{
 let s=subject();mapped=null;const m=await pending(s,'late-lid');
 await s.replayPendingMessages(scope());assert.equal(posts,0);assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,true);
 mapped=phone;s=subject();await s.replayPendingMessages(scope());await s.replayPendingMessages(scope());
 assert.equal(posts,1);const saved=await prisma.message.findUnique({where:{id:m.id}});assert.equal(saved.chatwootDeliveryPending,false);assert.equal(saved.key.remoteJid,lid);
});
test('HTTP failure remains pending and a later retry completes',async()=>{
 const s=subject(),m=await pending(s,'http-failure');failHttp=true;await s.replayPendingMessages(scope());
 assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,true);
 failHttp=false;await s.replayPendingMessages(scope());assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,false);
 assert.equal((await app.query('SELECT count(*) FROM messages')).rows[0].count,'1');
});
test('restart after remote commit but before local acknowledgement does not send again',async()=>{
 let s=subject();const m=await pending(s,'committed');await s.eventWhatsapp('messages.upsert',scope(),m);assert.equal(posts,1);
 s=subject();await s.replayPendingMessages(scope());assert.equal(posts,1);assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,false);
});
test('changed destination and another instance cannot consume a pending delivery',async()=>{
 const s=subject(),m=await pending(s,'wrong-target');const original=provider;provider={...provider,accountId:'7'};
 try{await s.replayPendingMessages(scope());assert.equal(posts,0);}finally{provider=original;}
 await s.replayPendingMessages({instanceName:'other-instance'});assert.equal(posts,0);assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,true);
});
test('overlapping replay calls deliver once',async()=>{
 const s=subject();await pending(s,'concurrent');await Promise.all([s.replayPendingMessages(scope()),s.replayPendingMessages(scope())]);assert.equal(posts,1);
});
test('receiver persists before the external delivery and a failed member does not drop the rest of the batch',async()=>{
 const c=cache();const r=new BaileysStartupService(configService,new EventEmitter2(),prisma,c,c,c,null);receivers.push(r);
 Object.assign(r.instance,{id:instance.id,name:instance.name});Object.assign(r.localChatwoot,provider);
 const s=subject();r.chatwootService=s;r.sendDataWebhook=async()=>{};
 const seen=[];s.eventWhatsapp=async(event,scope,body)=>{
  if(event!=='messages.upsert')return;
  const saved=await prisma.message.findFirst({where:{instanceId:instance.id,key:{path:['id'],equals:body.key.id}}});
  seen.push({id:body.key.id,persisted:!!saved,pending:saved?.chatwootDeliveryPending});throw Error('Synthetic interruption');
 };
 await r.messageHandle['messages.upsert']({type:'notify',messages:[data('batch-first',phone),data('batch-second',phone)]},{});
 assert.deepEqual(seen,[{id:'batch-first',persisted:true,pending:true},{id:'batch-second',persisted:true,pending:true}]);
 assert.equal(await prisma.message.count({where:{instanceId:instance.id,chatwootDeliveryPending:true}}),2);
});

test('independent workers share source-id deduplication',async()=>{
 const first=subject(),second=subject();await pending(first,'two-workers');
 await Promise.all([first.replayPendingMessages(scope()),second.replayPendingMessages(scope())]);
 assert.equal(posts,1);assert.equal((await app.query('SELECT count(*) FROM messages')).rows[0].count,'1');
});
test('disabled integration retains its pending records',async()=>{
 const s=subject(),m=await pending(s,'disabled');const original=provider;provider={...provider,enabled:false};
 try{await s.replayPendingMessages(scope());assert.equal(posts,0);assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,true);}finally{provider=original;}
});

test('pending attachment uses the live upload path and retains its source id',async()=>{
 const s=subject();const m=await pending(s,'media');
 await prisma.message.update({where:{id:m.id},data:{messageType:'documentMessage',message:{documentMessage:{fileName:'synthetic.txt',mimetype:'text/plain'}}}});
 await s.replayPendingMessages(scope());assert.equal(posts,1);assert.equal(attachmentSeen,true);
 assert.equal((await prisma.message.findUnique({where:{id:m.id}})).chatwootDeliveryPending,false);
 assert.equal((await app.query('SELECT source_id FROM messages')).rows[0].source_id,'WAID:media');
});

test('skipping disabled video storage does not discard the next received message',async()=>{
 const c=cache();const config={get(name){const value=configService.get(name);return name==='S3'?{...value,ENABLE:true,SAVE_VIDEO:false}:value;}};
 const r=new BaileysStartupService(config,new EventEmitter2(),prisma,c,c,c,null);receivers.push(r);
 Object.assign(r.instance,{id:instance.id,name:instance.name});Object.assign(r.localChatwoot,provider);r.sendDataWebhook=async()=>{};
 const s=subject(),seen=[];r.chatwootService=s;s.eventWhatsapp=async(event,scope,body)=>{
  if(event==='messages.upsert'){seen.push(body.key.id);throwIfSecond(body.key.id);return {id:99,inbox_id:30,conversation_id:42};}
 };
 function throwIfSecond(id){if(id==='after-video')throw Error('Synthetic delivery failure');}
 const video={...data('video-skip',phone),message:{videoMessage:{mimetype:'video/mp4'}}};
 await r.messageHandle['messages.upsert']({type:'notify',messages:[video,data('after-video',phone)]},{});
 assert.deepEqual(seen,['video-skip','after-video']);
 assert.equal(await prisma.message.count({where:{instanceId:instance.id}}),2);
});

for (const text of [undefined, '']) {
  test('reaction removal completes without creating a message, text=' + String(text), async () => {
    const s = subject();
    mapped = null;
    const m = await pending(s, 'removed-reaction');
    const reaction = { key: { id: 'original-message', remoteJid: lid, fromMe: false } };
    if (text !== undefined) reaction.text = text;
    await prisma.message.update({ where: { id: m.id }, data: { messageType: 'reactionMessage', message: { reactionMessage: reaction } } });
    await s.replayPendingMessages(scope());
    await subject().replayPendingMessages(scope());
    const saved = await prisma.message.findUnique({ where: { id: m.id } });
    assert.equal(saved.chatwootDeliveryPending, false);
    assert.equal(saved.chatwootMessageId, null);
    assert.deepEqual(saved.message, { reactionMessage: reaction });
    assert.equal(posts, 0);
    assert.equal((await app.query('SELECT count(*) FROM messages')).rows[0].count, '0');
  });
}

test('a non-empty reaction is delivered and acknowledged once', async () => {
  const s = subject(), m = await pending(s, 'added-reaction', phone);
  await prisma.message.update({ where: { id: m.id }, data: { messageType: 'reactionMessage',
    message: { reactionMessage: { key: { id: 'original-message', fromMe: true, remoteJid: phone }, text: '👍' } } } });
  await s.replayPendingMessages(scope());
  const saved = await prisma.message.findUnique({ where: { id: m.id } });
  assert.equal(saved.chatwootDeliveryPending, false);
  assert.ok(saved.chatwootMessageId);
  await s.replayPendingMessages(scope());
  assert.equal(posts, 1);
  assert.equal((await app.query('SELECT content FROM messages')).rows[0].content, '👍');
});
test('malformed reaction removal remains pending', async () => {
  const s = subject(), m = await pending(s, 'malformed-removal');
  mapped = null;
  await prisma.message.update({ where: { id: m.id }, data: { messageType: 'reactionMessage', message: { reactionMessage: { text: '' } } } });
  await s.replayPendingMessages(scope());
  assert.equal((await prisma.message.findUnique({ where: { id: m.id } })).chatwootDeliveryPending, true);
  assert.equal(posts, 0);
});
test('a live removal is preserved locally without enqueueing or sending it, and the next message proceeds', async () => {
  const c = cache();
  const r = new BaileysStartupService(configService, new EventEmitter2(), prisma, c, c, c, null);
  receivers.push(r);
  Object.assign(r.instance, { id: instance.id, name: instance.name });
  Object.assign(r.localChatwoot, provider);
  r.sendDataWebhook = async () => {};
  r.chatwootService = subject();
  const seen = [];
  r.chatwootService.eventWhatsapp = async (event, scope, body) => {
    if (event !== 'messages.upsert') return;
    seen.push(body.key.id);
    throw Error('Synthetic following-message failure');
  };
  const removal = { ...data('live-removal', phone), message: { reactionMessage: { key: { id: 'original-message' } } } };
  await r.messageHandle['messages.upsert']({ type: 'notify', messages: [removal, data('after-removal', phone)] }, {});
  const saved = await prisma.message.findFirst({ where: { instanceId: instance.id, key: { path: ['id'], equals: 'live-removal' } } });
  assert.equal(saved.chatwootDeliveryPending, false);
  assert.equal(saved.chatwootMessageId, null);
  assert.deepEqual(seen, ['after-removal']);
  assert.equal(await prisma.message.count({ where: { instanceId: instance.id, chatwootDeliveryPending: true } }), 1);
});

test('reaction removal cannot clear a delivery belonging to a different configured destination', async () => {
  const s = subject(), m = await pending(s, 'removal-other-target');
  await prisma.message.update({ where: { id: m.id }, data: { message: { reactionMessage: { key: { id: 'original-message' } } } } });
  const original = provider;
  provider = { ...provider, accountId: '7' };
  try {
    await s.replayPendingMessages(scope());
    assert.equal((await prisma.message.findUnique({ where: { id: m.id } })).chatwootDeliveryPending, true);
    assert.equal(posts, 0);
  } finally { provider = original; }
});
