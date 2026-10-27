# Deploy the standalone bridge

Build an immutable image from the reviewed fork commit with its Dockerfile.
Copy `compose.yaml` and a private `.env` based on `env.example` to the server.
Set PostgreSQL and Redis images to verified digests. Keep `.env` mode `0600`.
Run `docker compose -f compose.yaml config --quiet`, then `up -d`.

The API publishes only `127.0.0.1:3400`. PostgreSQL, Redis and WhatsApp sessions
have separate persistent volumes. Only the API joins the existing Chatwoot
network. The `nginx.conf` template needs a valid TLS certificate before release.
It denies the unsigned Chatwoot webhook on the public domain. Set the API inbox
webhook to `http://vartana-evolution:8080/chatwoot/webhook/<instance-name>`.
Do not expose that private webhook through another reverse proxy.

Use `chatwoot-import-role.sql` to create a non-superuser role and account-filtered
updatable views. Pass the approved `account_id`, `api_user_id`, `import_role` and a random
`import_password` to psql without logging the password. The role can read only
the permitted account and the selected administrator's token. Select an
administrator who belongs only to that account. It inserts through views
with `CHECK OPTION`; direct access to public tables is denied. Its search path
selects those views before `public`. Only the required ID sequences are granted.
The SQL is additive and runs in a transaction. It does not modify existing tables
or enable RLS on them. Start with one account and a fresh inbox.
Keep all Evolution credentials with trusted operators. Do not give the global
API key or database credential to customers.

Leave `importContacts=false`: the legacy agenda importer is separate from the
message importer and has not been hardened by this change. Message history still
creates contacts required by the imported conversations. Set
`mergeBrazilContacts=false` to avoid automatic contact merges.

Create an instance with `qrcode=false` and `syncFullHistory=true`, configure its
Chatwoot integration with `daysLimitImportMessages=90`, verify the saved settings,
and connect only after validation. Use a new inbox with an exclusive name.
Historical media uses placeholders. WhatsApp decides which history is available.
Set `CHATWOOT_IMPORT_HISTORICAL_MESSAGES=true` only when Chatwoot has the
`messages.historical` column. Lost live messages retain `historical=false`.

## Verify import behavior

Prepare a disposable PostgreSQL database named `evolution_import_test` with the
target Chatwoot schema and `conv_dpid_seq_6` and `conv_dpid_seq_7`. The tests
truncate synthetic records in that database. Never point them at a real account.
Set the import URI and `CHATWOOT_IMPORT_HISTORICAL_MESSAGES=true`, install the
locked dependencies, generate Prisma with `DATABASE_PROVIDER=postgresql`, then run:

```sh
node --require tsx/cjs --test test/chatwoot-history.test.cjs
node --require tsx/cjs --test test/chatwoot-import-role.test.cjs
npm run lint:check
npm run build
docker build -t evolution-api:<full-commit-sha> .
```

Keep backups of the Evolution database and instance volume before upgrades.
Rollback selects the previous immutable image and recreates only the API.
Do not remove its volumes or restore a database as part of an image rollback.
To remove the database adapter, stop the bridge, remove its inbox webhook,
drop the `evolution_import` schema, then revoke grants with `DROP OWNED BY` and
drop the dedicated role. These operations preserve imported customer records.
Views must be reviewed when the target Chatwoot schema changes.

The restricted-role test uses a disposable Docker container named
`evolution-import-test`, or `CHATWOOT_TEST_CONTAINER`. Run the two files in the
listed order, not concurrently, because they share the disposable database.
