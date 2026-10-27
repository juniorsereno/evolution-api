const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const adminUri = process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI;
if (!adminUri || new URL(adminUri).pathname !== '/evolution_import_test') {
  throw new Error('Use a disposable evolution_import_test PostgreSQL database with the Chatwoot schema.');
}
const admin = new Pool({ connectionString: adminUri });
let restricted;
let helper;
let postgresClient;

before(async () => {
  await admin.query(`TRUNCATE accounts, account_users, inboxes, access_tokens, messages, conversations, contact_inboxes, contacts CASCADE;
    INSERT INTO accounts (id,name,created_at,updated_at) VALUES (6,'Synthetic A',NOW(),NOW()),(7,'Synthetic B',NOW(),NOW());
    INSERT INTO inboxes (id,account_id,name,channel_type,channel_id,created_at,updated_at)
      VALUES (1001,6,'Allowed','Channel::Api',1001,NOW(),NOW()), (1003,7,'Denied','Channel::Api',1003,NOW(),NOW());
    INSERT INTO access_tokens (owner_type,owner_id,token,created_at,updated_at)
      VALUES ('User',1001,'synthetic-history-token',NOW(),NOW());
    INSERT INTO account_users (account_id,user_id,role,created_at,updated_at) VALUES (6,1001,1,NOW(),NOW());
    INSERT INTO contacts (id,name,account_id,created_at,updated_at) VALUES (99999,'Foreign contact',7,NOW(),NOW());`);
  execFileSync('docker', ['exec', '-i', process.env.CHATWOOT_TEST_CONTAINER || 'evolution-import-test',
    'psql', '-U', 'postgres', '-d', 'evolution_import_test',
    '-v', 'import_role=evolution_import_test_role', '-v', 'import_password=synthetic-import-only', '-v', 'account_id=6', '-v', 'api_user_id=1001'], {
    input: readFileSync('deploy/standalone/chatwoot-import-role.sql'), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const restrictedUri = new URL(adminUri);
  restrictedUri.username = 'evolution_import_test_role';
  restrictedUri.password = 'synthetic-import-only';
  process.env.CHATWOOT_IMPORT_DATABASE_CONNECTION_URI = restrictedUri.toString();
  restricted = new Pool({ connectionString: restrictedUri.toString() });
  helper = require('../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper').chatwootImport;
  postgresClient = require('../src/api/integrations/chatbot/chatwoot/libs/postgres.client').postgresClient;
});

after(async () => {
  if (postgresClient) await postgresClient.getChatwootConnection().end();
  if (restricted) await restricted.end();
  await admin.query(`DROP SCHEMA IF EXISTS evolution_import CASCADE;
    DROP OWNED BY evolution_import_test_role; DROP ROLE evolution_import_test_role;`);
  await admin.end();
});

test('imports with account-filtered updatable views and a non-superuser role', async () => {
  const instance = { instanceName: 'restricted-import' };
  helper.addHistoryMessages(instance, [{
    key: { id: 'restricted', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Synthetic allowed history' }, messageTimestamp: 1700000000,
  }]);
  assert.equal(await helper.importHistoryMessages(instance, {
    getConversationMessage: (message) => message.conversation,
  }, { id: 1001 }, { accountId: '6', token: 'synthetic-history-token', ignoreJids: [] }), 1);
  assert.equal((await restricted.query('SELECT count(*) FROM messages')).rows[0].count, '1');
  assert.equal((await restricted.query('SELECT * FROM contacts WHERE account_id = 7')).rowCount, 0);
  assert.equal((await restricted.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper, false);
});

test('cannot read underlying tables, users, or other accounts', async () => {
  await assert.rejects(restricted.query('SELECT * FROM public.messages'), { code: '42501' });
  await assert.rejects(restricted.query('SELECT * FROM public.contacts'), { code: '42501' });
  await assert.rejects(restricted.query('SELECT * FROM public.users'), { code: '42501' });
  assert.equal((await restricted.query('SELECT * FROM inboxes WHERE account_id = 7')).rowCount, 0);
});

test('cannot create cross-account contacts or link foreign contacts into the allowed inbox', async () => {
  await assert.rejects(restricted.query(`INSERT INTO contacts (name,account_id,created_at,updated_at)
    VALUES ('Denied',7,NOW(),NOW())`), { code: '44000' });
  await assert.rejects(restricted.query(`INSERT INTO contact_inboxes (contact_id,inbox_id,source_id,created_at,updated_at)
    VALUES (99999,1001,'denied',NOW(),NOW())`), { code: '44000' });
  await assert.rejects(restricted.query('DELETE FROM contacts'), { code: '42501' });
});
