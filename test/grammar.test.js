'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const labelScope = 'entity.name.label.llvm';
const localScope = 'variable.other.local.llvm';
let grammar;
let registry;

before(async () => {
  await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
  registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: sources => new oniguruma.OnigScanner(sources),
      createOnigString: text => new oniguruma.OnigString(text)
    }),
    loadGrammar: async scope => scope === 'source.llvm'
      ? textmate.parseRawGrammar(fs.readFileSync(path.join(__dirname, '../syntaxes/llvm-ir.tmLanguage.json'), 'utf8'), 'llvm-ir.tmLanguage.json')
      : null
  });
  grammar = await registry.loadGrammar('source.llvm');
});

after(() => registry?.dispose());

function scopesAt(line, target, offset = 0, stack = textmate.INITIAL) {
  const index = line.indexOf(target) + offset;
  assert.ok(line.includes(target), `missing target ${target}`);
  const token = grammar.tokenizeLine(line, stack).tokens.find(token => token.startIndex <= index && index < token.endIndex);
  assert.ok(token, `missing token at ${index}`);
  return token.scopes;
}

function hasScope(line, target, scope, offset = 0) {
  assert.ok(scopesAt(line, target, offset).includes(scope), `${JSON.stringify(target)} in ${JSON.stringify(line)} should have ${scope}`);
}

test('named, numeric and quoted label definitions use the standard label scope', () => {
  for (const label of ['entry', 'loop.exit', '42', '"quoted label"', '"escaped\\20label"']) {
    const line = `  ${label}: ; basic block`;
    hasScope(line, label, labelScope);
    hasScope(line, label, labelScope, label.length - 1);
    hasScope(line, ':', 'punctuation.separator.label.llvm');
    assert.ok(!scopesAt(line, 'basic').includes(labelScope));
  }
});

test('explicit label references include their sigil and match definition coloring', () => {
  for (const label of ['entry', '42', '"quoted label"', '"escaped\\20label"']) {
    const line = `  br i1 %condition, label\t %${label}, label %exit`;
    hasScope(line, `%${label}`, labelScope);
    hasScope(line, `%${label}`, labelScope, label.length);
    hasScope(line, '%exit', labelScope);
    hasScope(line, '%condition', localScope, 1);
    hasScope(line, 'label', 'support.type.primitive.llvm');
  }
});

test('phi predecessors are colored without changing the incoming SSA values', () => {
  const line = '  %answer = phi %Value [ %left, %entry ], [ %right, %"loop\\20back" ], [ %other, %42 ]';
  for (const label of ['%entry', '%"loop\\20back"', '%42']) hasScope(line, label, labelScope);
  for (const value of ['%answer', '%Value', '%left', '%right', '%other']) {
    hasScope(line, value, localScope, 1);
    assert.ok(!scopesAt(line, value).includes(labelScope));
  }
  hasScope(line, 'phi', 'keyword.other.operator.llvm');
});

test('ordinary local identifiers and named types are not label tokens', () => {
  for (const line of ['%entry = add i32 %left, %right', '%Value = type { i32, ptr }', '%v = load %Value, ptr %address', '%v = select i1 %c, i32 %entry, i32 %exit']) {
    assert.ok(grammar.tokenizeLine(line).tokens.every(token => !token.scopes.includes(labelScope)), line);
  }
  const stack = grammar.tokenizeLine('%x = phi i32 [ %v, %entry ]').ruleStack;
  assert.ok(grammar.tokenizeLine('%y = add i32 %v, %entry', stack).tokens.every(token => !token.scopes.includes(labelScope)));
});

test('comments and string contents do not acquire label or placeholder scopes', () => {
  for (const line of ['; entry: label %entry <result>', '@s = private constant [40 x i8] c"entry: label %entry <result>"', '%x = phi ptr [ c"label %entry <result>", %real ] ; label %fake']) {
    for (const token of grammar.tokenizeLine(line).tokens) {
      if (token.scopes.some(scope => scope.startsWith('comment.') || scope.startsWith('string.'))) {
        assert.ok(!token.scopes.includes(labelScope), line);
        assert.ok(!token.scopes.includes('variable.parameter.placeholder.llvm'), line);
      }
    }
  }
});

test('LangRef placeholders and comparison keywords have distinct useful scopes', () => {
  const line = '<result> = icmp samesign <cond> <ty> <op1>, <op2>';
  for (const placeholder of ['<result>', '<cond>', '<ty>', '<op1>', '<op2>']) {
    hasScope(line, placeholder, 'variable.parameter.placeholder.llvm');
  }
  hasScope(line, 'icmp', 'keyword.other.operator.llvm');
  hasScope(line, 'samesign', 'keyword.other.modifier.llvm');
  hasScope('%r = icmp sgt i32 %a, %b', 'sgt', 'keyword.operator.comparison.llvm');
  const vector = '%r = icmp eq <4 x i32> %a, %b';
  assert.ok(grammar.tokenizeLine(vector).tokens.every(token => !token.scopes.includes('variable.parameter.placeholder.llvm')));
  hasScope(vector, 'i32', 'support.type.integer.llvm');
});
