import type { MessageOrigin } from '@prisma/client';

export type OutboundOrigin =
  | { kind: 'api' }
  | { kind: 'chatwoot'; accountId: string; messageId: number; inboxId: number; conversationId: number };

export type ExternalMessageAttributes =
  | { external_source: 'whatsapp'; external_echo: true }
  | { external_source: 'evolution_api'; external_echo?: never }
  | { external_source?: never; external_echo?: never };

export function externalOriginAttributes(origin: Pick<MessageOrigin, 'origin'> | undefined): ExternalMessageAttributes {
  return origin?.origin === 'api'
    ? { external_source: 'evolution_api' }
    : { external_echo: true, external_source: 'whatsapp' };
}
