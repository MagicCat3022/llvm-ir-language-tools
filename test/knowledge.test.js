'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { entries, lookup } = require('../src/knowledge');
const grammar = require('../syntaxes/llvm-ir.tmLanguage.json');

test('all grammar instruction words have useful documentation and instruction syntax', () => {
  const modifiers = new Set(['musttail', 'notail', 'tail', 'unwind']);
  for (const section of ['instructions-control-flow', 'instructions']) {
    for (const pattern of grammar.repository[section].patterns) {
      const words = pattern.match.match(/\(([^)]+)\)/)[1].split('|');
      for (const word of words) {
        const entry = lookup(word);
        assert.ok(entry, `missing ${word}`);
        assert.ok(entry.summary.length > 35, `unhelpful summary: ${word}`);
        assert.equal(entry.kind, modifiers.has(word) ? 'keyword' : 'instruction', word);
        if (entry.kind === 'instruction') assert.ok(entry.syntax.includes(word), `missing syntax: ${word}`);
      }
    }
  }
});

test('entries have canonical official links and the shared data shape', () => {
  for (const [word, entry] of Object.entries(entries)) {
    const url = new URL(entry.url);
    assert.equal(url.origin, 'https://llvm.org', word);
    assert.equal(url.pathname, '/docs/LangRef.html', word);
    assert.match(url.hash, /^#[a-z][a-z0-9-]+$/, word);
    assert.ok(['instruction', 'keyword', 'type', 'attribute'].includes(entry.kind), word);
    assert.equal(typeof entry.summary, 'string', word);
    if (entry.details !== undefined) assert.equal(typeof entry.details, 'string', word);
    assert.ok(Object.isFrozen(entry), word);
  }
  assert.ok(lookup('trunc').url.endsWith('#trunc-to-instruction'));
  assert.ok(lookup('va_arg').url.endsWith('#va-arg-instruction'));
});

test('instruction syntax uses metavariables, not concrete SSA or global names', () => {
  for (const [word, entry] of Object.entries(entries)) {
    if (entry.kind !== 'instruction') continue;
    assert.doesNotMatch(entry.syntax, /[%@](?:[-a-zA-Z$._0-9]+|"[^"]*")/, word);
    if (word !== 'unreachable') assert.match(entry.syntax, /<[a-z][a-z0-9-]*>/, word);
  }
  assert.equal(lookup('add').syntax, '<result> = add <type> <op1>, <op2>');
  assert.match(lookup('call').syntax, /<callee>\(<typed-arguments>\)/);
  assert.match(lookup('br').syntax, /label <dest>/);
});

function predicateRows(entry) {
  return [...entry.details.matchAll(/^\| `([a-z]+)` \| (.+) \|$/gm)]
    .map(([, predicate, meaning]) => [predicate, meaning]);
}

test('icmp documents both syntax forms, every predicate, vector results and samesign poison', () => {
  const entry = lookup('icmp');
  assert.deepEqual(entry.syntax.split('\n'), [
    '<result> = icmp <cond> <ty> <op1>, <op2>',
    '<result> = icmp samesign <cond> <ty> <op1>, <op2>'
  ]);
  const rows = predicateRows(entry);
  assert.deepEqual(rows.map(([predicate]) => predicate), ['eq', 'ne', 'ugt', 'uge', 'ult', 'ule', 'sgt', 'sge', 'slt', 'sle']);
  for (const [predicate, meaning] of rows) {
    assert.ok(lookup(predicate), predicate);
    assert.ok(meaning.length > 10, predicate);
    if (predicate.startsWith('u')) assert.match(meaning, /unsigned/, predicate);
    if (predicate.startsWith('s')) assert.match(meaning, /signed/, predicate);
  }
  assert.match(entry.details, /Scalar operands produce `i1`/);
  assert.match(entry.details, /<N x i1>/);
  assert.match(entry.details, /`samesign`.*\n?Differing signs produce `poison`/);
  assert.match(lookup('samesign').summary, /same sign.*poison/);
});

test('fcmp documents all predicates and distinguishes ordered NaN checks from unsigned comparisons', () => {
  const entry = lookup('fcmp');
  const rows = predicateRows(entry);
  assert.deepEqual(rows.map(([predicate]) => predicate), [
    'false', 'oeq', 'ogt', 'oge', 'olt', 'ole', 'one', 'ord',
    'ueq', 'ugt', 'uge', 'ult', 'ule', 'une', 'uno', 'true'
  ]);
  for (const [predicate, meaning] of rows) {
    assert.ok(lookup(predicate), predicate);
    if (/^o(eq|gt|ge|lt|le|ne)$/.test(predicate)) assert.match(meaning, /^Ordered and /, predicate);
    if (/^u(eq|gt|ge|lt|le|ne)$/.test(predicate)) assert.match(meaning, /^Unordered or /, predicate);
  }
  assert.match(entry.details, /Ordered means neither operand is NaN/);
  assert.match(entry.details, /unordered means at least one operand is NaN/);
  assert.match(entry.details, /unordered, not unsigned/);
  assert.match(entry.syntax, /<cond> <ty> <op1>, <op2>/);
});

test('integer types are generated dynamically without claiming signedness', () => {
  for (const width of [1, 32, 129, 1024, 1942652, 8388607]) {
    const entry = lookup('i' + width);
    assert.equal(entry.kind, 'type');
    assert.match(entry.summary, new RegExp(`${width}-bit integer`));
    assert.match(entry.summary, /Signedness belongs to the operation/);
    assert.ok(entry.url.endsWith('#integer-type'));
  }
});

test('unknown, invalid and prototype-like names safely return undefined', () => {
  for (const value of ['made_up', 'constructor', '__proto__', 'toString', 'i0', 'i-1', 'i01', 'i8388608', 'i9999999999999999999', 'ADD', '', null, undefined, 32, {}]) {
    assert.equal(lookup(value), undefined, String(value));
  }
});

test('notes explain functions, opaque pointers, predecessor selection and overlapping words', () => {
  assert.match(lookup('define').summary, /function.*body/);
  assert.match(lookup('declare').summary, /without a body/);
  assert.match(lookup('ptr').summary, /pointee type is not encoded/);
  assert.match(lookup('phi').summary, /every predecessor/);
  assert.match(lookup('phi').summary, /precede non-phi/);
  assert.match(lookup('getelementptr').summary, /without reading memory/);
  assert.match(lookup('freeze').summary, /arbitrary fixed value/);
  assert.match(lookup('ugt').summary, /icmp.*fcmp/);
  assert.match(lookup('unwind').summary, /not a standalone instruction/);
  assert.match(lookup('noreturn').summary, /may still unwind/);
});
