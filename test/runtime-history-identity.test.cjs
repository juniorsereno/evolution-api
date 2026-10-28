const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test' ||
    new URL(process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI).pathname !== '/evolution_import_test') throw Error('Disposable test databases required');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { configService } = require('../dist/config/env.config');

test('compiled Chatwoot service imports verified LIDs and history names through both real databases', async () => {
  const prisma = new PrismaClient();
  const app = new Pool({ connectionString: process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI });
  const instance = await prisma.instance.create({ data: { name: 'synthetic-identity-' + Date.now() } });
  const lid = '1234567890123456@lid', phone = '5511999999999@s.whatsapp.net';
  const cache = { get: async () => null, set() {}, delete: async () => {} };
  let mappingCalls = 0;
  const monitor = { waInstances: { [instance.name]: { client: { signalRepository: { lidMapping: {
    getPNForLID: async value => { mappingCalls++; return value === lid ? '5511999999999:0@s.whatsapp.net' : null; },
  } } } } } };
  const subject = new ChatwootService(monitor, configService, prisma, cache);
  subject.provider = { accountId: '6', token: 'synthetic-history-token', importContacts: false };
  subject.getInbox = async () => ({ id: 1001 });
  subject.createBotMessage = async () => {};
  try {
    await app.query(`TRUNCATE accounts, inboxes, access_tokens, messages, conversations, contact_inboxes, contacts CASCADE;
      INSERT INTO accounts (id,name,created_at,updated_at) VALUES (6,'Synthetic identity',NOW(),NOW());
      INSERT INTO inboxes (id,account_id,name,channel_type,channel_id,created_at,updated_at)
        VALUES (1001,6,'Synthetic history','Channel::Api',1001,NOW(),NOW());
      INSERT INTO access_tokens (owner_type,owner_id,token,created_at,updated_at)
        VALUES ('User',1001,'synthetic-history-token',NOW(),NOW());`);
    await prisma.contact.create({ data: { instanceId: instance.id, remoteJid: lid, pushName: '1234567890123456' } });
    const event = (remoteJid,id) => ({ key: { id,remoteJid,fromMe:true }, pushName: 'Account owner',
      message: { conversation: 'Synthetic history' }, messageTimestamp: 1700000000 });
    await subject.addHistoryMessages({ instanceName: instance.name }, [event(lid,'verified'),event('9999999999999999@lid','unknown')],
      [{ remoteJid:lid,pushName:'History recipient name' }]);
    assert.equal(await subject.importHistoryMessages({ instanceName: instance.name }), 1);
    const contacts = (await app.query('SELECT name,phone_number,identifier FROM contacts')).rows;
    assert.deepEqual(contacts,[{name:'History recipient name',phone_number:'+5511999999999',identifier:phone}]);
    assert.equal(mappingCalls,2);
    const records = (await app.query('SELECT source_id,historical FROM messages')).rows;
    assert.deepEqual(records,[{source_id:'WAID:verified',historical:true}]);
  } finally {
    await prisma.instance.delete({where:{id:instance.id}});await prisma.$disconnect();await app.end();
    await subject.pgClient.end();
  }
});
