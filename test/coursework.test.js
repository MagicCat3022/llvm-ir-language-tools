'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { analyze, symbolAt, references, formatIR } = require('../src/analysis');
const { lookup } = require('../src/knowledge');
const { verifyIR } = require('../src/diagnostics');
const { courseFile, courseSkip } = require('./course-files');

const compiler = spawnSync('llvm-as', ['--version'], { encoding: 'utf8' });
for (const name of ['fact1', 'fact2', 'fib', 'max']) {
  const text = courseFile(`hw0/${name}.llvm`);
  test(name + ': actual coursework symbols, types, docs and reference scopes', { skip: courseSkip(`hw0/${name}.llvm`) }, () => {
    const analysis = analyze(text);
    const main = analysis.symbols.find(symbol => symbol.name === '@main');
    assert.equal(main.returnType, 'i32');
    assert.ok(analysis.symbols.some(symbol => symbol.name === '@printf' && symbol.variadic));
    const calls = analysis.tokens.filter(token => token.text === 'call');
    assert.ok(calls.length);
    assert.match(lookup('call').summary, /.+/);
    for (const symbol of analysis.symbols.filter(symbol => symbol.kind === 'variable')) {
      assert.notEqual(symbol.type, 'unknown', name + ': ' + symbol.scope + '/' + symbol.name);
      assert.equal(symbolAt(analysis, symbol.start).scope, symbol.scope);
      const fn = analysis.functions.find(fn => fn.name === symbol.scope);
      for (const reference of references(analysis, symbol)) {
        assert.ok(reference.start >= fn.start && reference.end <= fn.end);
      }
    }
  });
  test(name + ': formatting preserves compiler output', { skip: courseSkip(`hw0/${name}.llvm`) || (compiler.status !== 0 && 'llvm-as is not installed') }, async () => {
    const formatted = formatIR(text, { tabSize: 4, insertSpaces: true });
    assert.equal(formatIR(formatted, { tabSize: 4, insertSpaces: true }), formatted);
    const before = spawnSync('llvm-as', ['-o', '-', '-'], { input: text });
    const after = spawnSync('llvm-as', ['-o', '-', '-'], { input: formatted });
    assert.equal(before.status, 0, before.stderr.toString());
    assert.equal(after.status, 0, after.stderr.toString());
    assert.deepEqual(after.stdout, before.stdout, 'identical assembled bitcode');
    const result = await verifyIR(formatted);
    assert.equal(result.unavailable, undefined);
    assert.deepEqual(result.issues, []);
  });
}
test('language-features demo is valid LLVM IR', { skip: compiler.status !== 0 }, async () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../samples/language-features.ll'), 'utf8');
  const result = await verifyIR(text);
  assert.equal(result.unavailable, undefined);
  assert.deepEqual(result.issues, []);
});
