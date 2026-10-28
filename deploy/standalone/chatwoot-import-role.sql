\set ON_ERROR_STOP on

BEGIN;
CREATE ROLE :"import_role" LOGIN PASSWORD :'import_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE SCHEMA evolution_import;
REVOKE ALL ON SCHEMA evolution_import FROM PUBLIC;

CREATE VIEW evolution_import.inboxes WITH (security_barrier = true) AS
SELECT * FROM public.inboxes WHERE account_id = :account_id
WITH CASCADED CHECK OPTION;

CREATE VIEW evolution_import.contacts WITH (security_barrier = true) AS
SELECT * FROM public.contacts WHERE account_id = :account_id
WITH CASCADED CHECK OPTION;

CREATE VIEW evolution_import.contact_inboxes WITH (security_barrier = true) AS
SELECT * FROM public.contact_inboxes
WHERE inbox_id IN (SELECT id FROM public.inboxes WHERE account_id = :account_id)
  AND contact_id IN (SELECT id FROM public.contacts WHERE account_id = :account_id)
WITH CASCADED CHECK OPTION;

CREATE VIEW evolution_import.conversations WITH (security_barrier = true) AS
SELECT * FROM public.conversations
WHERE account_id = :account_id
  AND inbox_id IN (SELECT id FROM public.inboxes WHERE account_id = :account_id)
  AND contact_id IN (SELECT id FROM public.contacts WHERE account_id = :account_id)
  AND contact_inbox_id IN (
    SELECT ci.id FROM public.contact_inboxes ci
    JOIN public.inboxes i ON i.id = ci.inbox_id WHERE i.account_id = :account_id
  )
WITH CASCADED CHECK OPTION;

CREATE VIEW evolution_import.messages WITH (security_barrier = true) AS
SELECT m.* FROM public.messages m
WHERE m.account_id = :account_id AND EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = m.conversation_id AND c.account_id = :account_id AND c.inbox_id = m.inbox_id
)
WITH CASCADED CHECK OPTION;

CREATE VIEW evolution_import.access_tokens WITH (security_barrier = true) AS
SELECT t.owner_type, t.owner_id, t.token FROM public.access_tokens t
WHERE t.owner_type = 'User' AND t.owner_id = :api_user_id AND EXISTS (
  SELECT 1 FROM public.account_users au
  WHERE au.user_id = t.owner_id AND au.account_id = :account_id AND au.role = 1
);

GRANT CONNECT ON DATABASE :"DBNAME" TO :"import_role";
GRANT USAGE ON SCHEMA public, evolution_import TO :"import_role";
GRANT SELECT ON ALL TABLES IN SCHEMA evolution_import TO :"import_role";
GRANT INSERT ON evolution_import.contacts, evolution_import.contact_inboxes,
  evolution_import.conversations, evolution_import.messages TO :"import_role";
GRANT UPDATE (source_id, status, created_at, updated_at) ON evolution_import.messages TO :"import_role";
GRANT USAGE ON SEQUENCE public.contacts_id_seq, public.contact_inboxes_id_seq,
  public.conversations_id_seq, public.messages_id_seq TO :"import_role";
SELECT format('GRANT USAGE ON SEQUENCE public.%I TO %I', 'conv_dpid_seq_' || :'account_id', :'import_role') \gexec
ALTER ROLE :"import_role" IN DATABASE :"DBNAME" SET search_path = evolution_import, public;
COMMIT;
