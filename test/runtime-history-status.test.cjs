const assert = require('node:assert/strict');
const { before, beforeEach, afterEach, after, test } = require('node:test');
const http = require('node:http');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
const i18next = require('i18next');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test' ||
    new URL(process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI).pathname !== '/evolution_import_test') {
  throw Error('Use the disposable runtime and import databases.');
}
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const app = new Pool({ connectionString: process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI });
const notices = [], subjects = [], clients = [], filters = [];
let server, base, rejectNotices = false;
before(async () => {
  await i18next.init({ lng: 'pt-BR', resources: { 'pt-BR': { translation: require('../dist/translations/pt-BR.json') } } });
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = req.headers['content-type']?.startsWith('multipart/form-data')
      ? { content: raw.match(/name="content"\r\n\r\n([\s\S]*?)\r\n--/)?.[1] }
      : raw ? JSON.parse(raw) : null;
    const account = Number(req.url.match(/\/accounts\/(\d+)/)?.[1]);
    const inbox = account === 6 ? 1001 : 1003;
    const conversation = account === 6 ? 699 : 700;
    let result;
    if (req.url.endsWith('/contacts/filter')) {
      filters.push(body.payload);
      result = { payload: [{ id: 123, identifier: '123456' }] };
    } else if (req.url.endsWith('/inboxes')) {
      result = { payload: [{ id: inbox, name: 'Synthetic connection' }] };
    } else if (req.url.endsWith('/contacts/123/conversations')) {
      result = { payload: [{ id: conversation, inbox_id: inbox, status: 'open' }] };
    } else if (req.url.endsWith('/conversations/' + conversation + '/messages')) {
      const saved = Number((await app.query('SELECT count(*) FROM messages WHERE account_id=$1', [account])).rows[0].count);
      notices.push({ account, conversation, content: body.content, saved });
      if (rejectNotices) res.statusCode = 503;
      result = { id: notices.length, content: body.content };
    } else {
      res.statusCode = 404; result = { error: 'Unexpected synthetic route' };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async () => {
  notices.length = 0; filters.length = 0; rejectNotices = false;
  await app.query(`TRUNCATE accounts, inboxes, access_tokens, messages, conversations, contact_inboxes, contacts CASCADE;
    INSERT INTO accounts (id,name,created_at,updated_at) VALUES (6,'Synthetic A',NOW(),NOW()),(7,'Synthetic B',NOW(),NOW());
    INSERT INTO inboxes (id,account_id,name,channel_type,channel_id,created_at,updated_at) VALUES
      (1001,6,'Synthetic connection','Channel::Api',1001,NOW(),NOW()),(1003,7,'Synthetic connection','Channel::Api',1003,NOW(),NOW());
    INSERT INTO access_tokens (owner_type,owner_id,token,created_at,updated_at)
      VALUES ('User',1001,'synthetic-history-token',NOW(),NOW());`);
});
afterEach(async () => {
  for (const subject of subjects.splice(0)) {
    subject.messageProcessor.onDestroy();
    await prisma.instance.delete({ where: { id: subject.instanceId } });
  }
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  for (const pool of new Set(clients.map(service => service.pgClient))) await pool.end();
  await prisma.$disconnect(); await app.end();
});
async function service(account = '6') {
  const instance = await prisma.instance.create({ data: { name: 'synthetic-status-' + account + '-' + Date.now() } });
  const values = new Map();
  const cache = { has: async key => values.has(key), get: async key => values.get(key), set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, cache, cache, null);
  Object.assign(subject.instance, { id: instance.id, name: instance.name });
  const provider = { enabled: true, accountId: account, token: 'synthetic-history-token', url: base,
    nameInbox: 'Synthetic connection', importContacts: false, importMessages: true, daysLimitImportMessages: 90 };
  Object.assign(subject.localChatwoot, provider);
  subject.client = { signalRepository: { lidMapping: { getPNForLID: async () => null } } };
  subject.findChatwoot = async () => provider;
  subject.sendDataWebhook = async () => {};
  const monitor = { waInstances: { [instance.name]: subject } };
  const chatwoot = new ChatwootService(monitor, configService, prisma, cache);
  chatwoot.provider = provider;
  subject.chatwootService = chatwoot;
  subjects.push(subject); clients.push(chatwoot);
  return subject;
}
function batch(id = 'synthetic-status-message', remoteJid = '5511900000000@s.whatsapp.net', content = 'Synthetic history') {
  return { messages: [{ key: { id, remoteJid, fromMe: false }, message: { conversation: content },
    messageTimestamp: Math.floor(Date.now() / 1000) }], contacts: [], chats: [], progress: 100, syncType: 2 };
}
const processBatch = (subject, data) => subject.messageHandle['messaging-history.set'](data);

test('connection chat distinguishes received data from committed messages at WhatsApp progress 100', { timeout: 10000 }, async () => {
  const subject = await service();
  await processBatch(subject, batch());
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /Lote recebido do WhatsApp\. Mensagens: 1/);
  assert.match(notices[0].content, /100%/);
  assert.equal(notices[0].saved, 0);
  assert.match(notices[1].content, /Novas mensagens salvas na caixa de entrada: 1/);
  assert.equal(notices[1].saved, 1);
  assert.ok(notices.every(item => item.account === 6 && item.conversation === 699));
  assert.ok(filters.length > 0 && filters.every(payload => payload.every(filter => filter.values[0] === '123456')));
});

test('repeated batches report zero new messages without duplicating history', async () => {
  const subject = await service();
  await processBatch(subject, batch());
  await processBatch(subject, batch());
  assert.equal(notices.length, 4);
  assert.match(notices[3].content, /Novas mensagens salvas na caixa de entrada: 0/);
  assert.equal(notices[3].saved, 1);
});

test('unmapped LIDs remain in Evolution and are reported separately from saved messages', async () => {
  const subject = await service();
  await processBatch(subject, batch('synthetic-unknown-lid', '1234567890123456@lid'));
  assert.equal(await prisma.message.count({ where: { instanceId: subject.instanceId } }), 1);
  assert.match(notices[1].content, /Novas mensagens salvas na caixa de entrada: 0/);
  assert.match(notices[1].content, /Mensagens aguardando identificação do telefone: 1/);
  assert.equal(Number((await app.query('SELECT count(*) FROM contacts')).rows[0].count), 0);
});

test('a rolled-back batch reports failure and can be saved on a later empty batch', async () => {
  const subject = await service();
  await app.query(`CREATE FUNCTION reject_status_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.content = '__FAIL_STATUS__' THEN RAISE EXCEPTION 'Synthetic status failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_status_fixture BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_status_fixture();`);
  try {
    await processBatch(subject, batch('synthetic-status-rollback', undefined, '__FAIL_STATUS__'));
    assert.match(notices[1].content, /A importação na caixa de entrada não foi confirmada/);
    assert.equal(notices[1].saved, 0);
  } finally {
    await app.query('DROP TRIGGER reject_status_fixture ON messages; DROP FUNCTION reject_status_fixture()');
  }
  await processBatch(subject, { messages: [], chats: [], contacts: [], progress: 100, syncType: 2 });
  assert.match(notices[3].content, /Novas mensagens salvas na caixa de entrada: 1/);
  assert.equal(notices[3].saved, 1);
});

test('failure to publish connection notices does not cancel the database import', async () => {
  const subject = await service();
  rejectNotices = true;
  await processBatch(subject, batch());
  assert.equal(Number((await app.query('SELECT count(*) FROM messages')).rows[0].count), 1);
  assert.equal(notices.length, 2);
});

test('a preparation failure is reported without claiming that the batch was saved', async () => {
  const subject = await service();
  subject.client.signalRepository.lidMapping.getPNForLID = async () => { throw Error('Synthetic mapping failure'); };
  await processBatch(subject, batch('synthetic-mapping-failure', '1234567890123456@lid'));
  assert.match(notices[1].content, /A importação na caixa de entrada não foi confirmada/);
  assert.equal(notices[1].saved, 0);
});

test('notices stay in each account connection chat and preserve unknown progress', async () => {
  for (const account of ['6', '7']) {
    const subject = await service(account);
    await processBatch(subject, { ...batch('synthetic-status-' + account), progress: undefined });
  }
  assert.deepEqual(notices.map(item => [item.account, item.conversation]), [[6, 699], [6, 699], [7, 700], [7, 700]]);
  assert.ok(notices.every(item => item.content.includes('não informado')));
});

test('disabled message import does not publish notices or import into the inbox', async () => {
  const subject = await service();
  subject.localChatwoot.importMessages = false;
  await processBatch(subject, batch());
  assert.equal(notices.length, 0);
  assert.equal(Number((await app.query('SELECT count(*) FROM messages')).rows[0].count), 0);
});
