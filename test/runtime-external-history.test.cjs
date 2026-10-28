const assert = require('node:assert/strict');
const { beforeEach, after, test } = require('node:test');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { configService } = require('../dist/config/env.config');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test' ||
    new URL(process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI).pathname !== '/evolution_import_test') throw Error('Disposable databases required');
const prisma = new PrismaClient();
const app = new Pool({ connectionString: process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI });
const instances = [], services = [];
beforeEach(async () => {
  await app.query(`TRUNCATE accounts, inboxes, access_tokens, messages, conversations, contact_inboxes, contacts CASCADE;
    INSERT INTO accounts (id,name,created_at,updated_at) VALUES (6,'Synthetic A',NOW(),NOW()),(7,'Synthetic B',NOW(),NOW());
    INSERT INTO inboxes (id,account_id,name,channel_type,channel_id,created_at,updated_at)
      VALUES (1001,6,'Synthetic A','Channel::Api',1001,NOW(),NOW()),(1003,7,'Synthetic B','Channel::Api',1003,NOW(),NOW());
    INSERT INTO access_tokens (owner_type,owner_id,token,created_at,updated_at) VALUES ('User',1001,'synthetic-history-token',NOW(),NOW());`);
});
after(async () => {
  for (const instance of instances) await prisma.instance.delete({ where: { id: instance.id } });
  await prisma.$disconnect(); await app.end();
  for (const pool of new Set(services.map(service => service.pgClient))) await pool.end();
});
async function service() {
  const instance = await prisma.instance.create({ data: { name: 'synthetic-external-history-' + Date.now() + '-' + instances.length } });
  instances.push(instance);
  const subject = new ChatwootService({ waInstances: {} }, configService, prisma, { get: async () => null, set() {} });
  subject.provider = { accountId: '6', token: 'synthetic-history-token', importContacts: false, importMessages: true };
  subject.getInbox = async () => ({ id: 1001 });
  services.push(subject); return { instance, subject, dto: { instanceName: instance.name, instanceId: instance.id } };
}
const message = (id, fromMe = true) => ({ key: { id, fromMe, remoteJid: '5511900000000@s.whatsapp.net' },
  message: { conversation: 'Synthetic ' + id }, messageTimestamp: 1700000000 });
async function importBatch(subject, dto, messages) {
  await subject.addHistoryMessages(dto, messages, []);
  return subject.importHistoryMessages(dto, false);
}
async function original(subject, dto, sourceId = null) {
  assert.equal(await importBatch(subject, dto, [message('synthetic-seed', false)]), 1);
  const conversation = (await app.query('SELECT id,display_id FROM conversations WHERE account_id=6 AND inbox_id=1001')).rows[0];
  await app.query(`INSERT INTO messages (id,account_id,inbox_id,conversation_id,content,message_type,sender_type,sender_id,source_id,created_at,updated_at)
    VALUES (9001,6,1001,$1,'Synthetic original agent message',1,'User',1001,$2,NOW(),NOW())`, [conversation.id, sourceId]);
  return conversation;
}

test('outgoing history stores native-app metadata in the Rails JSON-store format without a token owner author', async () => {
  const { subject, dto } = await service();
  assert.equal(await importBatch(subject, dto, [message('synthetic-outside'), message('synthetic-incoming', false)]), 2);
  const records = (await app.query('SELECT source_id,sender_type,sender_id,content_attributes,status FROM messages ORDER BY source_id')).rows;
  const outgoing = records.find(row => row.source_id === 'WAID:synthetic-outside');
  assert.equal(outgoing.sender_type, null); assert.equal(outgoing.sender_id, null); assert.equal(outgoing.status, 1);
  assert.equal(typeof outgoing.content_attributes, 'string');
  assert.deepEqual(JSON.parse(outgoing.content_attributes), { external_echo: true, external_source: 'whatsapp' });
  assert.equal(records.find(row => row.source_id === 'WAID:synthetic-incoming').sender_type, 'Contact');
});

test('recovers multiple attachment IDs belonging to one Vartana message without blocking unrelated history or duplicating the message', async () => {
  const { instance, subject, dto } = await service();
  const conversation = await original(subject, dto, 'WAID:synthetic-attachment-b');
  await prisma.messageOrigin.createMany({ data: ['synthetic-attachment-a','synthetic-attachment-b'].map(messageId => ({
    instanceId: instance.id, messageId, origin: 'chatwoot', chatwootAccountId: '6', chatwootMessageId: 9001,
    chatwootInboxId: 1001, chatwootConversationId: conversation.display_id,
  })) });
  assert.equal(await importBatch(subject, dto, [message('synthetic-attachment-a'),message('synthetic-attachment-b'),message('synthetic-new-external')]), 1);
  const rows = (await app.query('SELECT id,sender_type,sender_id,source_id FROM messages ORDER BY id')).rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(row => Number(row.id) === 9001), { id: 9001, sender_type: 'User', sender_id: '1001', source_id: 'WAID:synthetic-attachment-b' });
});

test('links a Vartana send interrupted before source-ID mapping while preserving its author', async () => {
  const { instance, subject, dto } = await service();
  const conversation = await original(subject, dto);
  await prisma.messageOrigin.create({ data: { instanceId: instance.id, messageId: 'synthetic-recovery', origin: 'chatwoot',
    chatwootAccountId: '6', chatwootMessageId: 9001, chatwootInboxId: 1001, chatwootConversationId: conversation.display_id } });
  assert.equal(await importBatch(subject, dto, [message('synthetic-recovery')]), 0);
  const row = (await app.query('SELECT sender_type,sender_id,source_id FROM messages WHERE id=9001')).rows[0];
  assert.deepEqual(row, { sender_type: 'User', sender_id: '1001', source_id: 'WAID:synthetic-recovery' });
});

test('keeps origin lookup scoped to the current instance even when another instance has the same WhatsApp ID', async () => {
  const { subject, dto } = await service();
  const foreign = await service();
  await prisma.messageOrigin.create({ data: { instanceId: foreign.instance.id, messageId: 'synthetic-shared-key', origin: 'api' } });
  assert.equal(await importBatch(subject, dto, [message('synthetic-shared-key')]), 1);
  const row = (await app.query('SELECT content_attributes FROM messages')).rows[0];
  assert.equal(JSON.parse(row.content_attributes).external_source, 'whatsapp');
});
