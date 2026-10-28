# Deploy the standalone bridge

Build an immutable image from the reviewed fork commit with its Dockerfile.
Copy `compose.yaml` and a private `.env` based on `env.example` to the server.
Set PostgreSQL and Redis images to verified digests. Keep `.env` mode `0600`.
Run `docker compose -f compose.yaml config --quiet`, then `up -d`.

The API publishes only `127.0.0.1:3400`. PostgreSQL, Redis and WhatsApp sessions
have separate persistent volumes. Only the API joins the existing Chatwoot
network. The `nginx.conf` template needs a valid TLS certificate before release.
The Chatwoot hostname resolves to the Docker host only inside this API container.
Requests keep HTTPS and certificate validation while avoiding the public CDN.
It denies the unsigned native Chatwoot webhook on the public domain. Chatwoot's
SafeFetch rejects private network destinations. Render `webhook-location.conf.template`
with a random 256-bit secret and include it in the HTTPS server. The location
accepts only the VPS origin IP, restores visitor IPs only from official Cloudflare
ranges, and does not write its secret path to the access log. Keep the rendered
file private and set the inbox webhook to its HTTPS URL. Do not enable
`SAFE_FETCH_ALLOW_PRIVATE_NETWORK` globally. The original native route stays denied.
`CHATWOOT_BOT_CONTACT=true` creates the native connection chat and posts QR images
there. Send `init` to that control chat to request a fresh code.

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

Initial history is imported after each saved batch, including `INITIAL_BOOTSTRAP`.
It does not depend on a separate `FULL` notification or a timer. The message date
filter still limits imports to the configured number of days. Names use text
columns so one long contact name cannot reject an entire batch. Disabling
`importContacts` also skips bulk avatar enrichment and Chatwoot contact updates.
When enabled, that enrichment awaits each request instead of launching the whole
address book concurrently.
Keep `shouldSyncHistoryMessage` explicit: the pinned Baileys default excludes
`FULL` payloads. The Windows Desktop profile requires the official
`WIN_HYBRID` fix, pinned by the full Baileys commit
`0af2386292907f7d9742d8d41f830d8c48208fa1`. Its production delta from rc14 is
one line. `Ubuntu Desktop` still selects `WEB_BROWSER`; it does not enable the
full-history subplatform. Keep `syncFullHistory=true` and configure Windows
Desktop before pairing. Reconnect updates the login profile, but initial
full-sync device properties are sent only during registration. An existing
session may therefore need a fresh QR scan. WhatsApp still controls the
available history; a 90-day filter is not proof of 90-day delivery.

History identities are resolved through the session's Baileys LID mapping or a
verified phone alternate. Unresolved LIDs stay in Evolution storage and never
become fabricated phone numbers. Contact names use history metadata or inbound
push names, preserving existing Chatwoot names and avoiding the account owner's
outgoing push name. Use verified mappings and account/inbox-scoped evidence to
repair older fabricated records; do not infer a phone from LID digits.

The runtime regressions use a separate disposable `evolution_runtime_test`
database migrated with the Evolution schema. After building the production
JavaScript, run `node --test test/runtime-contact-sync.test.cjs test/runtime-long-names.test.cjs`
with that database URI and `DATABASE_SAVE_DATA_CONTACTS=true`,
`DATABASE_SAVE_DATA_HISTORIC=true`, `DATABASE_SAVE_IS_ON_WHATSAPP=false`,
`CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true`, and `CHATWOOT_ENABLED=true`.

The restricted-role test uses a disposable Docker container named
`evolution-import-test`, or `CHATWOOT_TEST_CONTAINER`. Run the two files in the
listed order, not concurrently, because they share the disposable database.
