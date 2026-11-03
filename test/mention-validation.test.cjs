const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Validator } = require('jsonschema');
const schemas = require('../src/validate/message.schema');
for (const name of ['textMessageSchema', 'mediaMessageSchema', 'ptvMessageSchema', 'audioMessageSchema', 'stickerMessageSchema', 'locationMessageSchema', 'pollMessageSchema', 'listMessageSchema', 'buttonsMessageSchema']) {
  test(`${name} validates mentionsEveryOne as a boolean`, () => {
    const validator = new Validator();
    for (const value of [true, false]) {
      const result = validator.validate({ mentionsEveryOne: value }, schemas[name]);
      assert.equal(result.errors.some(error => error.property === 'instance.mentionsEveryOne'), false);
    }
    for (const value of ['false', 'true', 1, null]) {
      const result = validator.validate({ mentionsEveryOne: value }, schemas[name]);
      assert.equal(result.errors.some(error => error.property === 'instance.mentionsEveryOne'), true);
    }
  });
}
