const assert = require('node:assert/strict');
const { test } = require('node:test');

test('installed Baileys accepts valid signatures and rejects tampered or malformed signatures', async () => {
  const { Curve } = await import('baileys/lib/Utils/crypto.js');
  const key = Curve.generateKeyPair();
  const message = Buffer.from('Synthetic consuming-package signature regression');
  const signature = Curve.sign(key.private, message);
  const invalid = Buffer.from(signature);
  invalid.writeUInt8(invalid.readUInt8(0) ^ 0xff, 0);
  assert.equal(Curve.verify(key.public, message, signature), true);
  assert.equal(Curve.verify(key.public, message, invalid), false);
  assert.equal(Curve.verify(key.public, message, Buffer.alloc(3)), false);
});
