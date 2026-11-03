const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

// Execute the actual socket hook without opening a WhatsApp connection.
const source = ts.createSourceFile('service.ts', fs.readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let hook;
let normalize;
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'patchMessageBeforeSending') hook = node.getText(source);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeListType') normalize = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(hook);
for (const wrapped of [false, true]) {
  test(`list normalization preserves protobuf values, wrapped=${wrapped}`, async () => {
    const { proto } = await import('baileys');
    const code = ts.transpileModule(`${normalize || ''}; globalThis.hook = ({${hook}}).patchMessageBeforeSending;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = vm.createContext({ proto });
    vm.runInContext(code, context);
    const inner = proto.Message.fromObject({ listMessage: { listType: proto.Message.ListMessage.ListType.PRODUCT_LIST, contextInfo: { ephemeralSettingTimestamp: '1700000000' } } });
    const message = wrapped ? proto.Message.create({ deviceSentMessage: { message: inner } }) : inner;
    const result = context.hook(message);
    const list = wrapped ? result.deviceSentMessage.message.listMessage : result.listMessage;
    assert.equal(list.listType, proto.Message.ListMessage.ListType.SINGLE_SELECT);
    assert.equal(typeof list.contextInfo.ephemeralSettingTimestamp.isZero, 'function');
    assert.doesNotThrow(() => proto.Message.encode(result).finish());
  });
}
