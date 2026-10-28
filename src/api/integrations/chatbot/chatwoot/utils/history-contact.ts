import type { Contact, Message } from '@prisma/client';

export type HistoryMessage = Message & { contactName?: string };

export function phoneJid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d{1,14})(?::\d+)?@s\.whatsapp\.net$/.exec(value);
  return match ? `${match[1]}@s.whatsapp.net` : null;
}

export function contactName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name && !/^[+\d\s()-]+$/.test(name) && !/@(?:lid|s\.whatsapp\.net)$/.test(name) ? name : undefined;
}

export async function prepareHistoryContacts(
  messages: Message[],
  contacts: Pick<Contact, 'remoteJid' | 'pushName'>[],
  resolveLid: (lid: string) => Promise<string | null>,
): Promise<HistoryMessage[]> {
  const names = new Map(contacts.map((contact) => [contact.remoteJid, contactName(contact.pushName)]));
  const resolved = new Map<string, string | null>();
  const prepared: HistoryMessage[] = [];
  for (const message of messages) {
    const key = message.key;
    if (!key || typeof key !== 'object' || Array.isArray(key) || typeof key.remoteJid !== 'string') continue;
    const originalJid = key.remoteJid;
    let jid = phoneJid(originalJid);
    if (!jid && originalJid.endsWith('@lid')) {
      jid = phoneJid(key.remoteJidAlt);
      if (!jid) {
        if (!resolved.has(originalJid)) resolved.set(originalJid, phoneJid(await resolveLid(originalJid)));
        jid = resolved.get(originalJid);
      }
    }
    if (!jid) continue;
    prepared.push({
      ...message,
      key: { ...key, remoteJid: jid },
      contactName:
        names.get(jid) ?? names.get(originalJid) ?? (!key.fromMe ? contactName(message.pushName) : undefined),
    });
  }
  return prepared;
}
