'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalName, decodedName } = require('../src/symbol-names');

test('workspace identities match quoted names by UTF-8 bytes', () => {
  assert.equal(canonicalName('@printf'), canonicalName('@"\\70rintf"'));
  assert.equal(canonicalName('@"é"'), canonicalName('@"\\C3\\A9"'));
  assert.equal(decodedName('@"\\70rintf"'), 'printf');
});
test('slot IDs and mangling markers do not silently become external names', () => {
  assert.notEqual(canonicalName('@0'), canonicalName('@"0"'));
  assert.notEqual(canonicalName('@printf'), canonicalName('@"\\01printf"'));
  assert.notEqual(canonicalName('@printf'), canonicalName('@_printf'));
  assert.notEqual(canonicalName('@printf'), canonicalName('@Printf'));
  assert.notEqual(canonicalName('@same'), canonicalName('%same'));
});
