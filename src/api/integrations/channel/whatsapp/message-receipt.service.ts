import { Message, Prisma, PrismaClient } from '@prisma/client';
import {
  type Contact,
  type GroupParticipant,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  type MessageUserReceiptUpdate,
  type WAMessageKey,
} from 'baileys';

export type ReceiptStatus = 'SERVER_ACK' | 'DELIVERY_ACK' | 'READ' | 'PLAYED';

const ranks: Record<string, number> = { SERVER_ACK: 1, DELIVERY_ACK: 2, READ: 3, PLAYED: 4 };

export function receiptStatus(status: number | undefined): ReceiptStatus | undefined {
  switch (status) {
    case 2:
      return 'SERVER_ACK';
    case 3:
      return 'DELIVERY_ACK';
    case 4:
      return 'READ';
    case 5:
      return 'PLAYED';
  }
}

export function participantReceiptStatus(receipt: MessageUserReceiptUpdate['receipt']): ReceiptStatus | undefined {
  const valid = (timestamp: unknown) => typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0;
  if (valid(receipt.playedTimestamp)) return 'PLAYED';
  if (valid(receipt.readTimestamp)) return 'READ';
  if (valid(receipt.receiptTimestamp)) return 'DELIVERY_ACK';
}

export function captureGroupReceiptRecipients(participants: GroupParticipant[], sender: Pick<Contact, 'id' | 'lid'>) {
  const own = new Set([sender.id, sender.lid].filter((id) => typeof id === 'string').map(jidNormalizedUser));
  const recipients: string[][] = [];
  for (const participant of participants) {
    const aliases = [
      ...new Set(
        [participant.id, participant.lid, participant.phoneNumber]
          .filter((id) => typeof id === 'string')
          .map(jidNormalizedUser),
      ),
    ];
    if (aliases.some((id) => own.has(id))) continue;
    const existing = recipients.find((member) => member.some((id) => aliases.includes(id)));
    if (existing) existing.push(...aliases.filter((id) => !existing.includes(id)));
    else recipients.push(aliases);
  }
  return recipients;
}

function groupStatus(
  snapshot: Prisma.JsonValue,
  receipts: { participant: string | null; status: string }[],
): ReceiptStatus {
  if (snapshot === null) return 'SERVER_ACK';
  if (
    !Array.isArray(snapshot) ||
    !snapshot.every((member) => Array.isArray(member) && member.every((id) => typeof id === 'string'))
  ) {
    throw new Error('Invalid group receipt recipient snapshot');
  }
  if (!snapshot.length) return 'SERVER_ACK';
  const recipientRanks = snapshot.map((member) => {
    if (!Array.isArray(member)) throw new Error('Invalid group receipt recipient');
    return Math.max(
      0,
      ...receipts
        .filter((receipt) => member.includes(receipt.participant))
        .map((receipt) => ranks[receipt.status] || 0),
    );
  });
  if (recipientRanks.every((rank) => rank >= ranks.READ)) return 'READ';
  if (recipientRanks.every((rank) => rank >= ranks.DELIVERY_ACK)) return 'DELIVERY_ACK';
  return 'SERVER_ACK';
}

function receiptChatJid(jid: string): string {
  return jidNormalizedUser(jid)
    .replace(/@hosted\.lid$/, '@lid')
    .replace(/@hosted$/, '@s.whatsapp.net');
}

export class MessageReceiptService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mysql: boolean,
    private readonly resolveLid: (lid: string) => Promise<string | null>,
  ) {}

  private async sameChat(receivedJid: string, storedJids: string[]): Promise<boolean> {
    const received = receiptChatJid(receivedJid);
    const stored = storedJids.map(receiptChatJid);
    if (!received) return false;
    if (stored.includes(received)) return true;
    if (isJidGroup(received) || stored.some(isJidGroup)) return false;

    const phone = isLidUser(received) ? receiptChatJid((await this.resolveLid(received)) || '') : received;
    if (!isPnUser(phone)) return false;
    for (const jid of stored) {
      const expected = isLidUser(jid) ? receiptChatJid((await this.resolveLid(jid)) || '') : jid;
      if (phone === expected) return true;
    }
    return false;
  }

  async record(
    instanceId: string,
    key: WAMessageKey,
    status: ReceiptStatus,
    saveUpdates: boolean,
    participant?: string,
  ) {
    if (!key.id) return null;
    return this.prisma.$transaction(
      async (tx) => {
        // Lock the parent before reading receipts: concurrent participants must observe each other's committed updates.
        const rows = this.mysql
          ? await tx.$queryRaw<
              Message[]
            >`SELECT * FROM Message WHERE instanceId=${instanceId} AND JSON_UNQUOTE(JSON_EXTRACT(\`key\`, '$.id'))=${key.id} LIMIT 1 FOR UPDATE`
          : await tx.$queryRaw<
              Message[]
            >`SELECT * FROM "Message" WHERE "instanceId"=${instanceId} AND "key"->>'id'=${key.id} LIMIT 1 FOR UPDATE`;
        const message = rows[0];
        if (!message) return null;
        const stored = message.key;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored) || typeof stored.remoteJid !== 'string') {
          throw new Error('Invalid persisted WhatsApp message key');
        }
        const fromMe = typeof stored.fromMe === 'boolean' ? stored.fromMe : key.fromMe;
        if (typeof fromMe !== 'boolean') throw new Error('Missing WhatsApp message direction');
        const storedJids = [stored.remoteJid, stored.remoteJidAlt].filter((jid) => typeof jid === 'string');
        if (key.remoteJid && !(await this.sameChat(key.remoteJid, storedJids))) return null;
        const group = isJidGroup(stored.remoteJid);
        if (participant && (!group || !fromMe)) return null;
        const member = participant ? jidNormalizedUser(participant) : key.participant || null;
        const normalizedKey: WAMessageKey = { ...key, remoteJid: stored.remoteJid, fromMe };
        const data = {
          instanceId,
          messageId: message.id,
          keyId: key.id,
          remoteJid: stored.remoteJid,
          fromMe,
          participant: member,
          status,
        };
        let recorded = false;
        if (saveUpdates && !(await tx.messageUpdate.findFirst({ where: data, select: { id: true } }))) {
          await tx.messageUpdate.create({ data });
          recorded = true;
        }
        const receipts =
          group && participant
            ? await tx.messageUpdate.findMany({
                where: { instanceId, messageId: message.id },
                select: { participant: true, status: true },
              })
            : [];
        if (!saveUpdates && participant) receipts.push({ participant: member, status });
        const next = group && participant ? groupStatus(message.groupReceiptRecipients, receipts) : status;
        const changed = (ranks[next] || 0) > (ranks[message.status] || 0);
        if (changed) await tx.message.update({ where: { id: message.id }, data: { status: next } });
        return { key: normalizedKey, data, recorded, changed, messageTimestamp: message.messageTimestamp };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
