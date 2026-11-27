const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Boom } = require('@hapi/boom');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');

const name = 'synthetic-outbound-error';
const recipient = '12025550100@s.whatsapp.net';
const provider = { accountId: '6', url: 'http://127.0.0.1:1', token: 'synthetic', signMsg: false };

test('a rejected WhatsApp key query fails the outbound Vartana webhook', async () => {
  const channel = Object.assign(Object.create(BaileysStartupService.prototype), {
    instance: { id: 'synthetic' },
    logger: { verbose() {}, error() {} },
    client: { presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {} },
    findChatwoot: async () => provider,
    whatsappNumber: async () => [{ exists: true, jid: recipient }],
    sendMessage: async () => { throw new Boom('not-acceptable', { data: 406 }); },
  });
  const service = new ChatwootService({ waInstances: { [name]: channel } }, configService, {}, {
    has: async () => false,
    set() {},
  });
  service.getQuotedMessage = async () => undefined;
  service.onSendMessageError = async () => {};
  try {
    const result = await service.receiveWebhook({ instanceName: name }, {
      id: 9001,
      event: 'message_created',
      message_type: 'outgoing',
      content: 'Synthetic',
      inbox: { id: 30 },
      conversation: { id: 42, meta: { sender: { identifier: recipient } }, messages: [{}] },
    });
    assert.deepEqual(result, { outboundError: 'WhatsApp rejected the encryption key request' });
  } finally {
    await service.pgClient.end();
  }
});
