const assert = require('node:assert/strict');
const { before, after, test, mock } = require('node:test');
const Module = require('node:module');
const EventEmitter2 = require('eventemitter2');
const axios = require('axios');
let baileys;
let proto;

let subject;
let socketConfig;
const socket = { ws: new EventEmitter2() };

before(async () => {
  baileys = await import('baileys');
  ({ proto } = baileys);
  const originalLoad = Module._load;
  const load = mock.method(Module, '_load', function (name, ...args) {
    if (name === 'baileys') {
      return { ...baileys, __esModule: true, default: config => {
        socketConfig = config;
        return socket;
      } };
    }
    return originalLoad.call(this, name, ...args);
  });
  let BaileysStartupService;
  try {
    ({ BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service'));
  } finally {
    load.mock.restore();
  }
  const { configService } = require('../dist/config/env.config');
  const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
  subject = new BaileysStartupService(configService, new EventEmitter2(), {}, cache, cache, cache, null);
  subject.defineAuthState = async () => ({ state: {
    creds: baileys.initAuthCreds(), keys: { get: async () => ({}), set: async () => {} },
  } });
  subject.eventHandler = () => {};
  const versionRequest = mock.method(axios, 'get', async url => {
    assert.equal(url, 'https://web.whatsapp.com/sw.js');
    return { data: '{"client_revision":123456}' };
  });
  try {
    assert.equal(await subject.reloadConnection(), socket);
  } finally {
    versionRequest.mock.restore();
  }
  assert.equal(typeof socketConfig?.patchMessageBeforeSending, 'function');
});

after(() => subject?.messageProcessor.onDestroy());

for (const wrapped of [false, true]) {
  test(`configured socket hook preserves protobuf values in lists, wrapped=${wrapped}`, async () => {
    const inner = proto.Message.fromObject({ listMessage: { listType: proto.Message.ListMessage.ListType.PRODUCT_LIST, contextInfo: { ephemeralSettingTimestamp: '1700000000' } } });
    const message = wrapped ? proto.Message.create({ deviceSentMessage: { message: inner } }) : inner;
    const result = await socketConfig.patchMessageBeforeSending(message);
    const list = wrapped ? result.deviceSentMessage.message.listMessage : result.listMessage;
    assert.equal(list.listType, proto.Message.ListMessage.ListType.SINGLE_SELECT);
    assert.equal(typeof list.contextInfo.ephemeralSettingTimestamp.isZero, 'function');
    assert.doesNotThrow(() => proto.Message.encode(result).finish());
  });
}
