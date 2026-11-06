const assert = require('node:assert/strict');
const { test } = require('node:test');
const pino = require('pino');

test('installed Baileys retains messages emitted by a flush listener', async () => {
  const { makeEventBuffer } = await import('baileys/lib/Utils/event-buffer.js');
  const events = makeEventBuffer(pino({ level: 'silent' }));
  const received = [];
  const emit = id => events.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id, remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'Synthetic' } }],
  });
  events.on('messages.upsert', ({ messages }) => {
    received.push(...messages.map(message => message.key.id));
    if (messages.some(message => message.key.id === 'first')) {
      events.buffer();
      emit('second');
    }
  });
  events.buffer();
  emit('first');
  events.flush();
  events.flush();
  assert.deepEqual(received, ['first', 'second']);
});
