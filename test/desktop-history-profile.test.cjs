const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = { version:[2,3000,1],browser:['Windows','Desktop','1.0.0'],syncFullHistory:true };

test('authenticated Windows Desktop requests the supported WIN_HYBRID full-history profile', async () => {
  const { generateLoginNode } = await import('baileys/lib/Utils/validate-connection.js');
  const payload = generateLoginNode('5511900000000:0@s.whatsapp.net',config);
  assert.equal(payload.webInfo.webSubPlatform,5);
});

test('full-history profile remains opt-in and Ubuntu Desktop still uses the web profile', async () => {
  const { generateLoginNode } = await import('baileys/lib/Utils/validate-connection.js');
  assert.equal(generateLoginNode('5511900000000:0@s.whatsapp.net',{...config,syncFullHistory:false}).webInfo.webSubPlatform,0);
  assert.equal(generateLoginNode('5511900000000:0@s.whatsapp.net',{...config,browser:['Ubuntu','Desktop','1.0.0']}).webInfo.webSubPlatform,0);
});
