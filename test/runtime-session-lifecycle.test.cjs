const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') throw Error('Disposable runtime database required');
test('dead socket logout and repeated deletion clean real records without touching a second tenant', async () => {
  await import('baileys');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const WAMonitoringService = require('../dist/api/server.module').waMonitor.constructor;
const { configService } = require('../dist/config/env.config');
  const prisma = new PrismaClient(), emitter = new EventEmitter2();
  const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
  const config = { get: name => name === 'CHATWOOT' ? { ENABLED: false } : configService.get(name) };
  const monitor = new WAMonitoringService(emitter, config, prisma, null, cache, cache, cache);
  const records = [];
  let subject;
  try {
    for (const suffix of ['a','b']) {
      const instance = await prisma.instance.create({ data: { name: 'synthetic-lifecycle-' + suffix, connectionStatus: 'open' } });
      records.push(instance);
      await prisma.session.create({ data: { sessionId: instance.id, creds: '{"synthetic":true}' } });
      await prisma.contact.create({ data: { instanceId: instance.id, remoteJid: suffix + '@s.whatsapp.net' } });
    }
    const [a,b] = records;
    subject = new BaileysStartupService(config, emitter, prisma, cache, cache, cache, null);
    subject.instance.id = a.id; subject.instance.name = a.name;
    subject.client = { logout: async () => { throw new Error('closed socket'); }, end: () => {} };
    subject.sendDataWebhook = async () => {};
    monitor.waInstances[a.name] = subject;
    await subject.logoutInstance();
    assert.equal((await prisma.instance.findUnique({ where: { id: a.id } })).connectionStatus, 'close');
    assert.equal(await prisma.session.count({ where: { sessionId: a.id } }), 0);
    await Promise.all([monitor.deleteInstance(a.name), monitor.deleteInstance(a.name)]);
    await monitor.deleteInstance(a.name);
    assert.equal(await prisma.instance.count({ where: { id: a.id } }), 0);
    assert.equal(await prisma.contact.count({ where: { instanceId: a.id } }), 0);
    assert.equal(await prisma.session.count({ where: { sessionId: b.id } }), 1);
    assert.equal(await prisma.contact.count({ where: { instanceId: b.id } }), 1);
    assert.equal((await prisma.instance.findUnique({ where: { id: b.id } })).connectionStatus, 'open');
  } finally {
    subject?.messageProcessor.onDestroy();
    await prisma.instance.deleteMany({ where: { id: { in: records.map(i => i.id) } } });
    await prisma.$disconnect();
  }
});
