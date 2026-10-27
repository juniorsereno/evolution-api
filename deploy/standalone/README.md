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

Use a non-superuser database role for `CHATWOOT_IMPORT_DATABASE_CONNECTION_URI`.
The importer requires `SELECT/INSERT` on contacts, contact_inboxes, conversations
and messages, `UPDATE(updated_at)` on contacts, `UPDATE(source_id,status,created_at,updated_at)`
on messages, access to the chosen user's access token, and `USAGE` on the four ID
sequences plus `conv_dpid_seq_<account-id>`. It also reads the target inbox.
No schema ownership, deletion, or migration rights are needed. Table grants do
not restrict rows by tenant. Keep Evolution credentials with trusted operators.
Do not give the global API key or database credential to customers.

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
npm run lint:check
npm run build
docker build -t evolution-api:<full-commit-sha> .
```

Keep backups of the Evolution database and instance volume before upgrades.
Rollback selects the previous immutable image and recreates only the API.
Do not remove its volumes or restore a database as part of an image rollback.
