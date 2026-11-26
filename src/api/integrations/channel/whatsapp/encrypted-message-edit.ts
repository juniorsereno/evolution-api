import { hkdfSync } from 'node:crypto';

import { aesDecryptGCM, isJidGroup, jidNormalizedUser, normalizeMessageContent, proto, WAMessageKey } from 'baileys';

type OriginalMessage = { key?: WAMessageKey; message?: proto.IMessage };
type OwnAddresses = { id?: string; lid?: string };

function addresses(primary?: string, alternate?: string): string[] {
  return [...new Set([primary, alternate].filter(Boolean).map(jidNormalizedUser).filter(Boolean))];
}

function authors(key: WAMessageKey, own: OwnAddresses): string[] {
  if (key.fromMe) return addresses(own.id, own.lid);
  return isJidGroup(key.remoteJid)
    ? addresses(key.participant, key.participantAlt)
    : addresses(key.remoteJid, key.remoteJidAlt);
}

function bytes(value: Uint8Array | string | undefined): Buffer | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : value && Buffer.from(value);
}

export function decryptMessageEdit(
  envelope: proto.Message.ISecretEncryptedMessage,
  editor: WAMessageKey,
  original: OriginalMessage,
  own: OwnAddresses = {},
): proto.Message.IProtocolMessage | undefined {
  const originalKey = original.key;
  const targetId = envelope.targetMessageKey?.id;
  if (!targetId || targetId !== originalKey?.id || editor.fromMe !== originalKey.fromMe) return;

  // The envelope's target addresses use the sender's perspective. Trust the stored and received addressing.
  const originalChat = addresses(originalKey.remoteJid, originalKey.remoteJidAlt);
  if (!addresses(editor.remoteJid, editor.remoteJidAlt).some((jid) => originalChat.includes(jid))) return;

  const originalAuthors = authors(originalKey, own);
  const editors = authors(editor, own);
  if (!editors.some((jid) => originalAuthors.includes(jid))) return;

  const secret = bytes(original.message?.messageContextInfo?.messageSecret);
  const iv = bytes(envelope.encIv);
  const ciphertext = bytes(envelope.encPayload);
  if (secret?.length !== 32 || iv?.length !== 12 || !ciphertext || ciphertext.length <= 16) return;

  for (const author of originalAuthors) {
    for (const modifier of editors) {
      try {
        const info = Buffer.from(targetId + author + modifier + 'Message Edit');
        const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
        const plaintext = aesDecryptGCM(ciphertext, key, iv, new Uint8Array());
        const decoded = normalizeMessageContent(proto.Message.decode(plaintext))?.protocolMessage;
        if (decoded?.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT || decoded.key?.id !== targetId) return;
        if (!decoded.editedMessage) return;
        return {
          type: decoded.type,
          key: originalKey,
          editedMessage: decoded.editedMessage,
          timestampMs: decoded.timestampMs,
        };
      } catch {
        // An authenticated PN/LID alias may differ between the stored original and the edit.
      }
    }
  }
}
