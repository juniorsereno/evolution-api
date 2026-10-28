const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { Pool } = require('pg');
const { chatwootImport } = require('../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper');
const { postgresClient } = require('../src/api/integrations/chatbot/chatwoot/libs/postgres.client');

const uri = process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI;
if (!uri || new URL(uri).pathname !== '/evolution_import_test') {
  throw new Error('Use a disposable evolution_import_test PostgreSQL database with the Chatwoot schema.');
}
const db = new Pool({ connectionString: uri });
const provider = { accountId: '6', token: 'synthetic-history-token', ignoreJids: [] };
const service = { getMessageOrigins: async () => [], getConversationMessage: (message) => message.conversation };
const instance = (name) => ({ instanceName: name });
const message = (id, content = 'History text') => ({
  key: { id, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
  message: { conversation: content },
  messageTimestamp: 1700000000,
});
const run = (name, messages, inboxId = 1001, accountId = '6', historical = true) => {
  chatwootImport.addHistoryMessages(instance(name), messages);
  return chatwootImport.importHistoryMessages(instance(name), service, { id: inboxId }, { ...provider, accountId }, historical);
};
const count = async () => Number((await db.query('SELECT count(*) FROM messages')).rows[0].count);

before(async () => {
  await db.query(`
    TRUNCATE accounts, inboxes, access_tokens, messages, conversations, contact_inboxes, contacts CASCADE;
    INSERT INTO accounts (id, name, created_at, updated_at) VALUES
      (6, 'Synthetic A', NOW(), NOW()), (7, 'Synthetic B', NOW(), NOW());
    INSERT INTO inboxes (id, account_id, name, channel_type, channel_id, created_at, updated_at) VALUES
      (1001, 6, 'Synthetic history', 'Channel::Api', 1001, NOW(), NOW()),
      (1002, 6, 'Synthetic other inbox', 'Channel::Api', 1002, NOW(), NOW()),
      (1003, 7, 'Synthetic other account', 'Channel::Api', 1003, NOW(), NOW());
    INSERT INTO access_tokens (owner_type, owner_id, token, created_at, updated_at)
      VALUES ('User', 1001, 'synthetic-history-token', NOW(), NOW());
  `);
});
beforeEach(async () => {
  await db.query('TRUNCATE messages, conversations, contact_inboxes, contacts CASCADE');
});
after(async () => {
  await postgresClient.getChatwootConnection().end();
  await db.end();
});

test('imports each external ID once across a repeated history and duplicate events in a batch', async () => {
  assert.equal(await run('repeat', [message('one'), message('one')]), 1);
  assert.equal(await run('repeat', [message('one'), message('two')]), 1);
  assert.equal(await count(), 2);
});

test('keeps the same external ID independent between inboxes and accounts', async () => {
  for (const [name, inboxId, accountId] of [['a', 1001, '6'], ['b', 1002, '6'], ['c', 1003, '7']]) {
    assert.equal(await run(name, [message('shared')], inboxId, accountId), 1);
    assert.equal(await run(name, [message('shared')], inboxId, accountId), 0);
  }
  assert.equal(await count(), 3);
});

test('serializes concurrent history imports to the same inbox', async () => {
  const results = await Promise.all([
    run('concurrent-a', [message('same')]),
    run('concurrent-b', [message('same')]),
  ]);
  assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
  assert.equal(await count(), 1);
});

test('preserves original timestamps and marks history without marking recovered live messages', async () => {
  assert.equal(await run('history', [message('history')]), 1);
  assert.equal(await run('recovery', [message('live')], 1001, '6', false), 1);
  const rows = (await db.query('SELECT source_id, historical, extract(epoch from created_at)::bigint AS ts FROM messages ORDER BY source_id')).rows;
  assert.deepEqual(rows.map((row) => [row.source_id, row.historical, row.ts]), [
    ['WAID:history', true, '1700000000'], ['WAID:live', false, '1700000000'],
  ]);
  assert.ok((await db.query('SELECT display_id FROM conversations')).rows.every((row) => row.display_id > 0));
});

test('rolls back earlier batches and retains pending events when a later batch fails', async () => {
  await db.query(`CREATE FUNCTION reject_history_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.content = '__FAIL_IMPORT__' THEN RAISE EXCEPTION 'Synthetic import failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_history_fixture BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_history_fixture();`);
  try {
    const messages = Array.from({ length: 4001 }, (_, i) => message(`rollback-${i}`, i === 4000 ? '__FAIL_IMPORT__' : 'ok'));
    assert.equal(await run('rollback', messages), undefined);
    assert.equal(await count(), 0);
    assert.equal(chatwootImport.getHistoryMessagesLenght(instance('rollback')), 4001);
  } finally {
    await db.query('DROP TRIGGER reject_history_fixture ON messages; DROP FUNCTION reject_history_fixture()');
  }
  assert.equal(await chatwootImport.importHistoryMessages(instance('rollback'), service, { id: 1001 }, provider), 4001);
  assert.equal(await count(), 4001);
});

test('serializes a live REST write with history and resolves account-scoped conversation display IDs', async () => {
  await run('setup-live', [message('setup')]);
  await db.query('UPDATE conversations SET display_id = 90001 WHERE inbox_id = 1001');
  let allowWrite;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { allowWrite = resolve; });
  const live = chatwootImport.createLiveMessage({
    accountId: '6', conversationDisplayId: 90001, sourceId: 'WAID:race',
    create: async () => {
      entered();
      await gate;
      await db.query(`INSERT INTO messages (content, account_id, inbox_id, conversation_id, message_type, source_id, created_at, updated_at)
        SELECT 'Live text', account_id, inbox_id, id, 0, 'WAID:race', NOW(), NOW() FROM conversations WHERE display_id = 90001 AND account_id = 6`);
      return { id: 'live-message' };
    },
  });
  await ready;
  const history = run('race-history', [message('race')]);
  allowWrite();
  assert.deepEqual(await live, { id: 'live-message' });
  assert.equal(await history, 0);
  assert.equal(await count(), 2);
  let called = false;
  assert.equal(await chatwootImport.createLiveMessage({
    accountId: '6', conversationDisplayId: 90001, sourceId: 'WAID:setup',
    create: async () => { called = true; },
  }), null);
  assert.equal(called, false);
  await assert.rejects(chatwootImport.createLiveMessage({
    accountId: '7', conversationDisplayId: 90001, sourceId: 'WAID:foreign', create: async () => {},
  }), /does not belong/);
});

test('rejects a mismatched account and inbox before writing history', async () => {
  assert.equal(await run('wrong-inbox', [message('wrong')], 1003, '6'), undefined);
  assert.equal(await count(), 0);
});

test('does not treat a database read failure as evidence that a message is absent', async () => {
  await assert.rejects(chatwootImport.getExistingSourceIds(['one'], { accountId: 'invalid-number', inboxId: 1001 }));
  assert.equal(await count(), 0);
});


test('never creates a phone from an unresolved LID, group or broadcast identifier', async () => {
  const events = ['1234567890123456@lid', '12345@g.us', 'status@broadcast'].map((remoteJid, i) => ({
    ...message(`unsupported-${i}`), key: { ...message().key, id: `unsupported-${i}`, remoteJid },
  }));
  assert.equal(await run('unresolved-lid', events), 0);
  assert.equal(Number((await db.query('SELECT count(*) FROM contacts')).rows[0].count), 0);
});

test('uses the verified alternate phone JID and recipient name without using an outgoing sender name', async () => {
  const event = message('mapped-lid');
  event.key.remoteJid = '1234567890123456@lid';
  event.key.remoteJidAlt = '5511999999999:0@s.whatsapp.net';
  event.key.fromMe = true;
  event.pushName = 'Synthetic account owner';
  event.contactName = 'Synthetic recipient';
  assert.equal(await run('mapped-lid', [event]), 1);
  const row = (await db.query('SELECT name, phone_number, identifier FROM contacts')).rows[0];
  assert.deepEqual(row, { name: 'Synthetic recipient', phone_number: '+5511999999999', identifier: '5511999999999@s.whatsapp.net' });
});

test('uses inbound push names for new contacts and preserves existing Vartana contact names', async () => {
  const incoming = message('named-incoming');
  incoming.pushName = 'Synthetic WhatsApp name';
  assert.equal(await run('named-incoming', [incoming]), 1);
  assert.equal((await db.query('SELECT name FROM contacts')).rows[0].name, incoming.pushName);
  await db.query("UPDATE contacts SET name = 'Vartana edited name'");
  const next = message('named-next'); next.pushName = 'Changed WhatsApp name';
  assert.equal(await run('named-next', [next]), 1);
  assert.equal((await db.query('SELECT name FROM contacts')).rows[0].name, 'Vartana edited name');
});
