import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { inbox } from '@figuro/chatwoot-sdk';
import { Chatwoot as ChatwootModel, Contact, Message } from '@prisma/client';
import { proto } from 'baileys';
import type { Pool, PoolClient } from 'pg';

import { contactName, HistoryMessage, phoneJid } from './history-contact';

type ChatwootUser = {
  user_type: string;
  user_id: number;
};

type FksChatwoot = {
  phone_number: string;
  contact_id: string;
  conversation_id: string;
};

type firstLastTimestamp = {
  first: number;
  last: number;
};

type IWebMessageInfo = Omit<proto.IWebMessageInfo, 'key'> & Partial<Pick<proto.IWebMessageInfo, 'key'>>;

class ChatwootImport {
  private logger = new Logger('ChatwootImport');
  private repositoryMessagesCache = new Map<string, Set<string>>();
  private historyMessages = new Map<string, HistoryMessage[]>();
  private historyContacts = new Map<string, Contact[]>();

  public getRepositoryMessagesCache(instance: InstanceDto) {
    return this.repositoryMessagesCache.has(instance.instanceName)
      ? this.repositoryMessagesCache.get(instance.instanceName)
      : null;
  }

  public setRepositoryMessagesCache(instance: InstanceDto, repositoryMessagesCache: Set<string>) {
    this.repositoryMessagesCache.set(instance.instanceName, repositoryMessagesCache);
  }

  public deleteRepositoryMessagesCache(instance: InstanceDto) {
    this.repositoryMessagesCache.delete(instance.instanceName);
  }

  public addHistoryMessages(instance: InstanceDto, messagesRaw: HistoryMessage[]) {
    const actualValue = this.historyMessages.has(instance.instanceName)
      ? this.historyMessages.get(instance.instanceName)
      : [];
    this.historyMessages.set(instance.instanceName, [...actualValue, ...messagesRaw]);
  }

  public addHistoryContacts(instance: InstanceDto, contactsRaw: Contact[]) {
    const actualValue = this.historyContacts.has(instance.instanceName)
      ? this.historyContacts.get(instance.instanceName)
      : [];
    this.historyContacts.set(instance.instanceName, actualValue.concat(contactsRaw));
  }

  public deleteHistoryMessages(instance: InstanceDto) {
    this.historyMessages.delete(instance.instanceName);
  }

  public deleteHistoryContacts(instance: InstanceDto) {
    this.historyContacts.delete(instance.instanceName);
  }

  public clearAll(instance: InstanceDto) {
    this.deleteRepositoryMessagesCache(instance);
    this.deleteHistoryMessages(instance);
    this.deleteHistoryContacts(instance);
  }

  public getHistoryMessagesLenght(instance: InstanceDto) {
    return this.historyMessages.get(instance.instanceName)?.length ?? 0;
  }

  public async importHistoryContacts(instance: InstanceDto, provider: ChatwootDto) {
    try {
      if (this.getHistoryMessagesLenght(instance) > 0) {
        return;
      }

      const pgClient = postgresClient.getChatwootConnection();

      let totalContactsImported = 0;

      const contacts = this.historyContacts.get(instance.instanceName) || [];
      if (contacts.length === 0) {
        return 0;
      }

      let contactsChunk: Contact[] = this.sliceIntoChunks(contacts, 3000);
      while (contactsChunk.length > 0) {
        const labelSql = `SELECT id FROM labels WHERE title = '${provider.nameInbox}' AND account_id = ${provider.accountId} LIMIT 1`;

        let labelId = (await pgClient.query(labelSql))?.rows[0]?.id;

        if (!labelId) {
          // creating label in chatwoot db and getting the id
          const sqlLabel = `INSERT INTO labels (title, color, show_on_sidebar, account_id, created_at, updated_at) VALUES ('${provider.nameInbox}', '#34039B', true, ${provider.accountId}, NOW(), NOW()) RETURNING id`;

          labelId = (await pgClient.query(sqlLabel))?.rows[0]?.id;
        }

        // inserting contacts in chatwoot db
        let sqlInsert = `INSERT INTO contacts
          (name, phone_number, account_id, identifier, created_at, updated_at) VALUES `;
        const bindInsert = [provider.accountId];

        for (const contact of contactsChunk) {
          const isGroup = this.isIgnorePhoneNumber(contact.remoteJid);

          const contactName = isGroup ? `${contact.pushName} (GROUP)` : contact.pushName;
          bindInsert.push(contactName);
          const bindName = `$${bindInsert.length}`;

          let bindPhoneNumber: string;
          if (!isGroup) {
            bindInsert.push(`+${contact.remoteJid.split('@')[0]}`);
            bindPhoneNumber = `$${bindInsert.length}`;
          } else {
            bindPhoneNumber = 'NULL';
          }
          bindInsert.push(contact.remoteJid);
          const bindIdentifier = `$${bindInsert.length}`;

          sqlInsert += `(${bindName}, ${bindPhoneNumber}, $1, ${bindIdentifier}, NOW(), NOW()),`;
        }
        if (sqlInsert.slice(-1) === ',') {
          sqlInsert = sqlInsert.slice(0, -1);
        }
        sqlInsert += ` ON CONFLICT (identifier, account_id)
                       DO UPDATE SET
                        name = EXCLUDED.name,
                        phone_number = EXCLUDED.phone_number,
                        updated_at = NOW()`;

        totalContactsImported += (await pgClient.query(sqlInsert, bindInsert))?.rowCount ?? 0;

        const sqlTags = `SELECT id FROM tags WHERE name = '${provider.nameInbox}' LIMIT 1`;

        const tagData = (await pgClient.query(sqlTags))?.rows[0];
        let tagId = tagData?.id;

        const sqlTag = `INSERT INTO tags (name, taggings_count) VALUES ('${provider.nameInbox}', ${totalContactsImported}) ON CONFLICT (name) DO UPDATE SET taggings_count = tags.taggings_count + ${totalContactsImported} RETURNING id`;

        tagId = (await pgClient.query(sqlTag))?.rows[0]?.id;

        await pgClient.query(sqlTag);

        let sqlInsertLabel = `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) VALUES `;

        contactsChunk.forEach((contact) => {
          const bindTaggableId = `(SELECT id FROM contacts WHERE identifier = '${contact.remoteJid}' AND account_id = ${provider.accountId})`;
          sqlInsertLabel += `($1, $2, ${bindTaggableId}, $3, NOW()),`;
        });

        if (sqlInsertLabel.slice(-1) === ',') {
          sqlInsertLabel = sqlInsertLabel.slice(0, -1);
        }

        await pgClient.query(sqlInsertLabel, [tagId, 'Contact', 'labels']);

        contactsChunk = this.sliceIntoChunks(contacts, 3000);
      }

      this.deleteHistoryContacts(instance);

      return totalContactsImported;
    } catch (error) {
      this.logger.error(`Error on import history contacts: ${error.toString()}`);
    }
  }

  public async getExistingSourceIds(
    sourceIds: string[],
    scope: { accountId: string; inboxId: number },
    pgClient: Pool | PoolClient = postgresClient.getChatwootConnection(),
  ): Promise<Set<string>> {
    const existingSourceIdsSet = new Set<string>();

    if (sourceIds.length === 0) {
      return existingSourceIdsSet;
    }

    // Ensure all sourceIds are consistently prefixed with 'WAID:' as required by downstream systems and database queries.
    const formattedSourceIds = sourceIds.map((sourceId) => `WAID:${sourceId.replace('WAID:', '')}`);
    const params = [formattedSourceIds, scope.accountId, scope.inboxId];
    const query = 'SELECT source_id FROM messages WHERE source_id = ANY($1) AND account_id = $2 AND inbox_id = $3';

    const result = await pgClient.query(query, params);
    for (const row of result.rows) {
      existingSourceIdsSet.add(row.source_id);
    }

    return existingSourceIdsSet;
  }

  public async createLiveMessage<T>({
    accountId,
    conversationDisplayId,
    sourceId,
    create,
  }: {
    accountId: string;
    conversationDisplayId: number;
    sourceId: string;
    create: () => Promise<T>;
  }): Promise<T | null> {
    const pgClient: PoolClient = await postgresClient.getChatwootConnection().connect();
    try {
      await pgClient.query('BEGIN');
      const result = await pgClient.query<{ inbox_id: number }>(
        'SELECT inbox_id FROM conversations WHERE account_id = $1 AND display_id = $2',
        [accountId, conversationDisplayId],
      );
      const conversation = result.rows[0];
      if (!conversation) throw new Error('Conversation does not belong to the configured account.');

      await pgClient.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
        accountId,
        conversation.inbox_id,
      ]);
      const existing = await this.getExistingSourceIds(
        [sourceId],
        { accountId, inboxId: conversation.inbox_id },
        pgClient,
      );
      const message = existing.size > 0 ? null : await create();
      await pgClient.query('COMMIT');
      return message;
    } catch (error) {
      await pgClient.query('ROLLBACK');
      throw error;
    } finally {
      pgClient.release();
    }
  }

  public async importHistoryMessages(
    instance: InstanceDto,
    chatwootService: ChatwootService,
    inbox: inbox,
    provider: ChatwootModel,
    historical = true,
  ) {
    const pgClient: PoolClient = await postgresClient.getChatwootConnection().connect();
    let pendingMessages: HistoryMessage[] = [];
    try {
      await pgClient.query('BEGIN');
      await pgClient.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [provider.accountId, inbox.id]);

      pendingMessages = this.historyMessages.get(instance.instanceName) || [];
      this.deleteHistoryMessages(instance);
      if (pendingMessages.length === 0) {
        await pgClient.query('COMMIT');
        return 0;
      }

      const target = await pgClient.query('SELECT id FROM inboxes WHERE id = $1 AND account_id = $2', [
        inbox.id,
        provider.accountId,
      ]);
      if (target.rowCount !== 1) throw new Error('Inbox does not belong to the configured account.');

      const chatwootUser = await this.getChatwootUser(provider, pgClient);
      if (!chatwootUser) {
        throw new Error('User not found to import messages.');
      }

      let totalMessagesImported = 0;

      let messagesOrdered = [...pendingMessages];

      // ordering messages by number and timestamp asc
      messagesOrdered.sort((a, b) => {
        const aKey = a.key as {
          remoteJid: string;
        };

        const bKey = b.key as {
          remoteJid: string;
        };

        const aMessageTimestamp = a.messageTimestamp as any as number;
        const bMessageTimestamp = b.messageTimestamp as any as number;

        return parseInt(aKey.remoteJid) - parseInt(bKey.remoteJid) || aMessageTimestamp - bMessageTimestamp;
      });

      const allMessagesMappedByPhoneNumber = this.createMessagesMapByPhoneNumber(messagesOrdered);
      // Map structure: +552199999999 => { first message timestamp from number, last message timestamp from number}
      const phoneNumbersWithTimestamp = new Map<string, firstLastTimestamp>();
      allMessagesMappedByPhoneNumber.forEach((messages: Message[], phoneNumber: string) => {
        phoneNumbersWithTimestamp.set(phoneNumber, {
          first: messages[0]?.messageTimestamp as any as number,
          last: messages[messages.length - 1]?.messageTimestamp as any as number,
        });
      });

      const existingSourceIds = await this.getExistingSourceIds(
        messagesOrdered.map((message: any) => message.key.id),
        { accountId: provider.accountId, inboxId: inbox.id },
        pgClient,
      );
      messagesOrdered = messagesOrdered.filter((message: any) => {
        const sourceId = `WAID:${message.key.id}`;
        if (existingSourceIds.has(sourceId)) return false;
        existingSourceIds.add(sourceId);
        return true;
      });
      // processing messages in batch
      const batchSize = 4000;
      let messagesChunk: HistoryMessage[] = this.sliceIntoChunks(messagesOrdered, batchSize);
      while (messagesChunk.length > 0) {
        // Map structure: +552199999999 => Message[]
        const messagesByPhoneNumber = this.createMessagesMapByPhoneNumber(messagesChunk);

        if (messagesByPhoneNumber.size > 0) {
          const fksByNumber = await this.selectOrCreateFksFromChatwoot(
            provider,
            inbox,
            phoneNumbersWithTimestamp,
            messagesByPhoneNumber,
            pgClient,
          );

          // inserting messages in chatwoot db
          const markHistorical = historical && configService.get<Chatwoot>('CHATWOOT').IMPORT.HISTORICAL_MESSAGES;
          let sqlInsertMsg = `INSERT INTO messages
            (content, processed_message_content, account_id, inbox_id, conversation_id, message_type, private, content_type,
            sender_type, sender_id, source_id, created_at, updated_at${markHistorical ? ', historical' : ''}) VALUES `;
          const bindInsertMsg = [provider.accountId, inbox.id];

          messagesByPhoneNumber.forEach((messages: any[], phoneNumber: string) => {
            const fksChatwoot = fksByNumber.get(phoneNumber);

            messages.forEach((message) => {
              if (!message.message) {
                return;
              }

              if (!fksChatwoot?.conversation_id || !fksChatwoot?.contact_id) {
                return;
              }

              const contentMessage = this.getContentMessage(chatwootService, message);
              if (!contentMessage) {
                return;
              }

              bindInsertMsg.push(contentMessage);
              const bindContent = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(fksChatwoot.conversation_id);
              const bindConversationId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? '1' : '0');
              const bindMessageType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_type : 'Contact');
              const bindSenderType = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.key.fromMe ? chatwootUser.user_id : fksChatwoot.contact_id);
              const bindSenderId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push('WAID:' + message.key.id);
              const bindSourceId = `$${bindInsertMsg.length}`;

              bindInsertMsg.push(message.messageTimestamp as number);
              const bindmessageTimestamp = `$${bindInsertMsg.length}`;

              sqlInsertMsg += `(${bindContent}, ${bindContent}, $1, $2, ${bindConversationId}, ${bindMessageType}, FALSE, 0,
                  ${bindSenderType},${bindSenderId},${bindSourceId}, to_timestamp(${bindmessageTimestamp}),
                  to_timestamp(${bindmessageTimestamp})${markHistorical ? ', TRUE' : ''}),`;
            });
          });
          if (bindInsertMsg.length > 2) {
            if (sqlInsertMsg.slice(-1) === ',') {
              sqlInsertMsg = sqlInsertMsg.slice(0, -1);
            }
            totalMessagesImported += (await pgClient.query(sqlInsertMsg, bindInsertMsg))?.rowCount ?? 0;
          }
        }
        messagesChunk = this.sliceIntoChunks(messagesOrdered, batchSize);
      }

      await pgClient.query('COMMIT');
      this.deleteRepositoryMessagesCache(instance);

      const providerData: ChatwootDto = {
        ...provider,
        ignoreJids: Array.isArray(provider.ignoreJids) ? provider.ignoreJids.map((event) => String(event)) : [],
      };

      if (provider.importContacts) await this.importHistoryContacts(instance, providerData);

      return totalMessagesImported;
    } catch (error) {
      await pgClient.query('ROLLBACK');
      this.logger.error(`Error on import history messages: ${error.toString()}`);
      this.addHistoryMessages(instance, pendingMessages);
    } finally {
      pgClient.release();
    }
  }

  public async selectOrCreateFksFromChatwoot(
    provider: ChatwootModel,
    inbox: inbox,
    phoneNumbersWithTimestamp: Map<string, firstLastTimestamp>,
    messagesByPhoneNumber: Map<string, HistoryMessage[]>,
    pgClient: Pool | PoolClient = postgresClient.getChatwootConnection(),
  ): Promise<Map<string, FksChatwoot>> {
    await pgClient.query('SELECT pg_advisory_xact_lock($1::integer, 0)', [provider.accountId]);
    const bindValues = [provider.accountId, inbox.id];
    const phoneNumberBind = Array.from(messagesByPhoneNumber.keys())
      .map((phoneNumber) => {
        const phoneNumberTimestamp = phoneNumbersWithTimestamp.get(phoneNumber);

        if (phoneNumberTimestamp) {
          bindValues.push(phoneNumber);
          let bindStr = `($${bindValues.length},`;

          bindValues.push(phoneNumberTimestamp.first);
          bindStr += `$${bindValues.length},`;

          bindValues.push(phoneNumberTimestamp.last);
          bindStr += `$${bindValues.length},`;
          const messages = messagesByPhoneNumber.get(phoneNumber);
          const name =
            messages.map((message) => contactName(message.contactName)).find(Boolean) ??
            messages
              .filter((message) => {
                const key = message.key;
                return key && typeof key === 'object' && !Array.isArray(key) && !key.fromMe;
              })
              .map((message) => contactName(message.pushName))
              .find(Boolean);
          bindValues.push(name ?? phoneNumber);
          return `${bindStr}$${bindValues.length}::text)`;
        }
      })
      .join(',');

    const inputs = `WITH target AS (SELECT $1::integer AS account_id, $2::integer AS inbox_id),
      phone_number AS (
        SELECT phone_number, created_at::INTEGER, last_activity_at::INTEGER, contact_name
        FROM (VALUES ${phoneNumberBind}) AS t (phone_number, created_at, last_activity_at, contact_name)
      )`;

    await pgClient.query(
      `${inputs}
      INSERT INTO contacts (name, phone_number, account_id, identifier, created_at, updated_at)
      SELECT p.contact_name, p.phone_number, t.account_id,
        CONCAT(REPLACE(p.phone_number, '+', ''), '@s.whatsapp.net'),
        to_timestamp(p.created_at), to_timestamp(p.last_activity_at)
      FROM phone_number p CROSS JOIN target t
      WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id = t.account_id AND c.phone_number = p.phone_number)`,
      bindValues,
    );

    await pgClient.query(
      `${inputs}
      INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
      SELECT c.id, t.inbox_id, gen_random_uuid(), c.created_at, c.updated_at
      FROM phone_number p CROSS JOIN target t
      JOIN LATERAL (
        SELECT id, created_at, updated_at FROM contacts
        WHERE account_id = t.account_id AND phone_number = p.phone_number ORDER BY id LIMIT 1
      ) c ON TRUE
      WHERE NOT EXISTS (SELECT 1 FROM contact_inboxes ci WHERE ci.contact_id = c.id AND ci.inbox_id = t.inbox_id)`,
      bindValues,
    );

    await pgClient.query(
      `${inputs}
      INSERT INTO conversations (account_id, inbox_id, status, contact_id, contact_inbox_id,
        uuid, last_activity_at, created_at, updated_at)
      SELECT t.account_id, t.inbox_id, 0, c.id, ci.id, gen_random_uuid(),
        to_timestamp(p.last_activity_at), to_timestamp(p.created_at), to_timestamp(p.last_activity_at)
      FROM phone_number p CROSS JOIN target t
      JOIN contacts c ON c.phone_number = p.phone_number AND c.account_id = t.account_id
      JOIN contact_inboxes ci ON ci.contact_id = c.id AND ci.inbox_id = t.inbox_id
      WHERE NOT EXISTS (SELECT 1 FROM conversations con
        WHERE con.account_id = t.account_id AND con.inbox_id = t.inbox_id AND con.contact_inbox_id = ci.id)`,
      bindValues,
    );

    const fksFromChatwoot = await pgClient.query(
      `${inputs}
      SELECT DISTINCT ON (p.phone_number) p.phone_number, c.id AS contact_id, con.id AS conversation_id
      FROM phone_number p CROSS JOIN target t
      JOIN contacts c ON c.phone_number = p.phone_number AND c.account_id = t.account_id
      JOIN contact_inboxes ci ON ci.contact_id = c.id AND ci.inbox_id = t.inbox_id
      JOIN conversations con ON con.contact_inbox_id = ci.id AND con.account_id = t.account_id
        AND con.inbox_id = t.inbox_id AND con.contact_id = c.id
      ORDER BY p.phone_number, con.last_activity_at DESC, con.id DESC`,
      bindValues,
    );

    return new Map(fksFromChatwoot.rows.map((item: FksChatwoot) => [item.phone_number, item]));
  }

  public async getChatwootUser(
    provider: ChatwootModel,
    pgClient: Pool | PoolClient = postgresClient.getChatwootConnection(),
  ): Promise<ChatwootUser> {
    try {
      const sqlUser = `SELECT owner_type AS user_type, owner_id AS user_id
                         FROM access_tokens
                       WHERE token = $1`;

      return (await pgClient.query(sqlUser, [provider.token]))?.rows[0] || false;
    } catch (error) {
      this.logger.error(`Error on getChatwootUser: ${error.toString()}`);
    }
  }

  public createMessagesMapByPhoneNumber(messages: HistoryMessage[]): Map<string, HistoryMessage[]> {
    const result = new Map<string, HistoryMessage[]>();
    for (const message of messages) {
      const key = message.key;
      if (!key || typeof key !== 'object' || Array.isArray(key)) continue;
      const jid =
        phoneJid(key.remoteJid) ??
        (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@lid') ? phoneJid(key.remoteJidAlt) : null);
      if (!jid) continue;
      const phoneNumber = `+${jid.split('@')[0]}`;
      const grouped = result.get(phoneNumber) ?? [];
      grouped.push(message);
      result.set(phoneNumber, grouped);
    }
    return result;
  }

  public async getContactsOrderByRecentConversations(
    inbox: inbox,
    provider: ChatwootModel,
    limit = 50,
  ): Promise<{ id: number; phone_number: string; identifier: string }[]> {
    try {
      const pgClient = postgresClient.getChatwootConnection();

      const sql = `SELECT contacts.id, contacts.identifier, contacts.phone_number
                     FROM conversations
                   JOIN contacts ON contacts.id = conversations.contact_id
                   WHERE conversations.account_id = $1
                     AND inbox_id = $2
                   ORDER BY conversations.last_activity_at DESC
                   LIMIT $3`;

      return (await pgClient.query(sql, [provider.accountId, inbox.id, limit]))?.rows;
    } catch (error) {
      this.logger.error(`Error on get recent conversations: ${error.toString()}`);
    }
  }

  public getContentMessage(chatwootService: ChatwootService, msg: IWebMessageInfo) {
    const contentMessage = chatwootService.getConversationMessage(msg.message);
    if (contentMessage) {
      return contentMessage;
    }

    if (!configService.get<Chatwoot>('CHATWOOT').IMPORT.PLACEHOLDER_MEDIA_MESSAGE) {
      return '';
    }

    const types = {
      documentMessage: msg.message.documentMessage,
      documentWithCaptionMessage: msg.message.documentWithCaptionMessage?.message?.documentMessage,
      imageMessage: msg.message.imageMessage,
      videoMessage: msg.message.videoMessage,
      audioMessage: msg.message.audioMessage,
      stickerMessage: msg.message.stickerMessage,
      templateMessage: msg.message.templateMessage?.hydratedTemplate?.hydratedContentText,
    };

    const typeKey = Object.keys(types).find((key) => types[key] !== undefined && types[key] !== null);
    switch (typeKey) {
      case 'documentMessage': {
        const doc = msg.message.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'documentWithCaptionMessage': {
        const doc = msg.message.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = doc?.fileName || 'document';
        const caption = doc?.caption ? ` ${doc.caption}` : '';
        return `_<File: ${fileName}${caption}>_`;
      }

      case 'templateMessage': {
        const template = msg.message.templateMessage?.hydratedTemplate;
        return (
          (template?.hydratedTitleText ? `*${template.hydratedTitleText}*\n` : '') +
          (template?.hydratedContentText || '')
        );
      }

      case 'imageMessage':
        return '_<Image Message>_';

      case 'videoMessage':
        return '_<Video Message>_';

      case 'audioMessage':
        return '_<Audio Message>_';

      case 'stickerMessage':
        return '_<Sticker Message>_';

      default:
        return '';
    }
  }

  public sliceIntoChunks(arr: any[], chunkSize: number) {
    return arr.splice(0, chunkSize);
  }

  public isGroup(remoteJid: string) {
    return remoteJid.includes('@g.us');
  }

  public isIgnorePhoneNumber(remoteJid: string) {
    return this.isGroup(remoteJid) || remoteJid === 'status@broadcast' || remoteJid === '0@s.whatsapp.net';
  }

  public updateMessageSourceID(messageId: string | number, sourceId: string) {
    const pgClient = postgresClient.getChatwootConnection();

    const sql = `UPDATE messages SET source_id = $1, status = 0, created_at = NOW(), updated_at = NOW() WHERE id = $2;`;

    return pgClient.query(sql, [`WAID:${sourceId}`, messageId]);
  }
}

export const chatwootImport = new ChatwootImport();
