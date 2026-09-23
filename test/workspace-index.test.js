'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/workspace-index');

function fixture(files) {
  const index = new WorkspaceIndex();
  for (const [uri, text] of Object.entries(files)) index.upsert(uri, text, { root: 'project', version: 1 });
  return index;
}
const position = (index, uri, name) => index.get(uri).text.indexOf(name) + 1;
const define = 'define i32 @foo(i32 %x) {\n ret i32 %x\n}\n';
const caller = 'declare i32 @foo(i32)\ndefine i32 @caller() {\n %v = call i32 @foo(i32 1)\n ret i32 %v\n}\n';

test('cross-file definitions, references and atomic function rename', () => {
  const index = fixture({ a: define, b: caller });
  assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['a']);
  assert.equal(index.references('a', position(index, 'a', '@foo')).length, 3);
  assert.equal(index.references('a', position(index, 'a', '@foo'), false).length, 1);
  const plan = index.rename('b', position(index, 'b', '@foo'), 'bar');
  assert.equal(plan.error, undefined);
  assert.equal(plan.edits.length, 3);
  assert.ok(plan.edits.every(edit => edit.newText === '@bar'));
  assert.ok(plan.edits.every(edit => index.get(edit.uri).text.slice(edit.start, edit.end) === '@foo'));
});

test('external global declarations and variable rename', () => {
  const index = fixture({ a: '@count = global i32 0\n', b: '@count = external global i32\n@pointer = global ptr @count\n' });
  assert.deepEqual(index.definitions('b', 2).map(item => item.uri), ['a']);
  assert.equal(index.references('a', 2, false).length, 1);
  assert.equal(index.rename('a', 2, '@total').edits.length, 3);
});

test('private and internal shadowing is module-local; visibility is not linkage', () => {
  const index = fixture({ a: define.replace('define ', 'define hidden dso_local '), b: caller,
    c: define.replace('define ', 'define private ') + '@p = global ptr @foo\n',
    d: define.replace('define ', 'define internal ') });
  assert.deepEqual(index.references('b', position(index, 'b', '@foo')).map(item => item.uri), ['a', 'b', 'b']);
  assert.deepEqual(index.definitions('c', position(index, 'c', '@foo')).map(item => item.uri), ['c']);
  assert.equal(index.rename('c', position(index, 'c', '@foo'), 'local').edits.length, 2);
  assert.equal(index.rename('b', position(index, 'b', '@foo'), 'exported').edits.length, 3);
});

test('same-spelled types, metadata, local values and numbered globals never cross files', () => {
  const text = '%T = type { i32 }\n!0 = !{i32 1}\n@0 = global i32 0\n' + define;
  const index = fixture({ a: text, b: text });
  for (const name of ['%T', '!0', '@0', '%x']) {
    assert.ok(index.definitions('a', position(index, 'a', name)).every(item => item.uri === 'a'));
    assert.ok(index.references('a', position(index, 'a', name)).every(item => item.uri === 'a'));
  }
  assert.match(index.rename('a', position(index, 'a', '@0'), 'new').error, /Numbered/);
  assert.equal(index.rename('a', position(index, 'a', '%x'), 'new'), undefined);
});

test('canonical UTF8/hex spelling is shared without demangling, case or leading-01 stripping', () => {
  const index = fixture({ a: define, b: caller.replaceAll('@foo', '@"\\66oo"'), c: 'declare i32 @"\\01foo"(i32)\n', d: 'declare i32 @Foo(i32)\n' });
  assert.equal(index.references('a', position(index, 'a', '@foo')).length, 3);
  assert.equal(index.rename('a', position(index, 'a', '@foo'), '@"b\\61r"').edits.length, 3);
  assert.deepEqual(index.definitions('c', position(index, 'c', '@"')).map(item => item.uri), ['c']);
  const utf = fixture({ a: define.replace('@foo', '@"é"'), b: caller.replaceAll('@foo', '@"\\C3\\a9"') });
  assert.equal(utf.references('a', position(utf, 'a', '@"')).length, 3);
});

test('separate roots and dirty upsert/remove/clear maintain fresh snapshots', () => {
  const index = fixture({ a: define, b: caller });
  index.upsert('c', define, { root: 'another', version: 9 });
  assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 3);
  index.upsert('a', define.replace('@foo', '@new'), { root: 'project', version: 2 });
  assert.equal(index.get('a').version, 2);
  assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['b']);
  index.remove('a'); assert.equal(index.get('a'), undefined);
  assert.equal(index.documents().length, 2);
  index.clear(); assert.equal(index.documents().length, 0);
});

test('incompatible signatures are not merged and prevent rename', () => {
  for (const declaration of ['declare i64 @foo(i32)', 'declare i32 @foo(i64)', 'declare i32 @foo(i32, ...)',
    'declare fastcc i32 @foo(i32)', 'declare signext i32 @foo(i32)', 'declare i32 @foo(i32 signext)',
    'declare i32 @foo(i32) addrspace(1)']) {
    const index = fixture({ a: define, b: declaration + '\n' });
    assert.equal(index.references('a', position(index, 'a', '@foo')).length, 1, declaration);
    assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['b'], declaration);
    assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /ABI/, declaration);
  }
});

test('ABI-sensitive pointer parameters, named types and attribute groups remain conservative', () => {
  for (const parameter of ['ptr byval(i32)', 'ptr sret(i32)', 'ptr addrspace(1)', 'ptr inalloca(i32)', 'ptr swiftself']) {
    const index = fixture({ a: 'define void @foo(ptr %p) {\n ret void\n}', b: `declare void @foo(${parameter})` });
    assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /ABI/);
  }
  for (const tail of ['(%T %p)', '(ptr %p) #0']) {
    const index = fixture({ a: `%T = type { i32 }\ndefine void @foo${tail} {\n ret void\n}`, b: `%T = type { i32 }\ndeclare void @foo${tail}` });
    assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /ABI/);
  }
});

test('incompatible known triples and layouts do not navigate across or rename', () => {
  for (const setting of ['triple', 'datalayout']) {
    const index = fixture({ a: `target ${setting} = "one"\n` + define, b: `target ${setting} = "two"\n` + caller });
    assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['b']);
    assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /triples|layouts/);
  }
});

test('duplicate course main definitions and replaceable linkage are unsafe to rename', () => {
  const index = fixture({ a: define, b: define, c: caller });
  assert.deepEqual(index.definitions('c', position(index, 'c', '@foo')).map(item => item.uri), ['a', 'b']);
  assert.deepEqual(index.definitions('a', position(index, 'a', '@foo')).map(item => item.uri), ['a']);
  assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /exactly one/);
  for (const linkage of ['weak', 'weak_odr', 'linkonce', 'linkonce_odr', 'available_externally']) {
    const other = fixture({ a: define.replace('define ', `define ${linkage} `), b: caller });
    assert.equal(other.definitions('b', position(other, 'b', '@foo'))[0].uri, 'a');
    assert.match(other.rename('a', position(other, 'a', '@foo'), 'bar').error, /linkage/);
  }
  for (const linkage of ['common', 'appending']) {
    const other = fixture({ a: `@foo = ${linkage} global i32 0`, b: '@foo = external global i32' });
    assert.match(other.rename('a', 2, 'bar').error, /linkage/);
  }
});

test('alias identity stays independent but direct references to renamed targets are edited', () => {
  const index = fixture({ a: define + '@alias = alias i32 (i32), ptr @foo\n', b: caller });
  assert.equal(index.references('a', position(index, 'a', '@alias')).length, 1);
  assert.match(index.rename('a', position(index, 'a', '@alias'), 'new').error, /Alias/);
  const plan = index.rename('a', position(index, 'a', '@foo'), 'bar');
  assert.equal(plan.edits.length, 4);
  assert.ok(plan.edits.every(edit => index.get(edit.uri).text.slice(edit.start, edit.end) === '@foo'));
});

test('COMDAT and symbol-bearing assembly conservatively block rename', () => {
  for (const source of [define.replace(') {', ') comdat {'), 'module asm "call foo"\n' + define,
    define.replace('ret i32 %x', 'call void asm sideeffect "call foo", ""()\n ret i32 %x')]) {
    const index = fixture({ a: source, b: caller });
    const plan = index.rename('a', position(index, 'a', '@foo'), 'bar');
    assert.equal(plan.edits.length, 0); assert.match(plan.error, /COMDAT|assembly/);
  }
});

test('downstream private collisions, external-only APIs and reserved names are rejected atomically', () => {
  const index = fixture({ a: define, b: caller + '@"b\\61r" = private global i32 0\n' });
  assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 0);
  assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /already exists/);
  const external = fixture({ a: 'declare i32 @printf(ptr, ...)' });
  assert.match(external.rename('a', position(external, 'a', '@printf'), 'print').error, /external-only/);
  for (const name of ['@llvm.foo', '@"llvm.foo"']) assert.match(index.rename('a', position(index, 'a', '@foo'), name).error, /reserved/);
  for (const name of ['%bar', '@1', 'bad name', '@"bad\\z"', '']) assert.ok(index.rename('a', position(index, 'a', '@foo'), name).error);
});

test('strings, comments, names and initializer text do not determine linkage or receive edits', () => {
  const index = fixture({ a: define.replace('%x', '%internal') + '@s = constant [12 x i8] c"@foo private"\n; @foo internal\n', b: caller });
  const plan = index.rename('a', position(index, 'a', '@foo'), 'bar');
  assert.equal(plan.edits.length, 3);
  assert.equal(index.definitions('a', index.get('a').text.indexOf('; @foo') + 3).length, 0);
});

test('workspace completion and search keep roots, names, locations and module-local exclusions', () => {
  const index = fixture({ a: define, b: 'declare void @llvm.trap()\n@0 = global i32 0\n@local = internal global i32 0\n%T = type { i32 }\n@global = global i32 0\n', c: '' });
  index.upsert('d', 'define void @outside() {\nret void\n}', { root: 'other' });
  assert.deepEqual(index.completions('c', 0).map(item => item.symbol.name), ['@foo', '@global']);
  assert.ok(!index.completions('a', 0).some(item => item.symbol.name === '@foo'));
  assert.deepEqual(index.search('FOO', 'project').map(item => item.uri), ['a']);
  assert.ok(index.search('T', 'project').some(item => item.symbol.kind === 'type'));
  assert.equal(index.search('outside', 'project').length, 0);
  assert.equal(index.search('outside').length, 1);
});

test('unresolved globals can navigate to candidates without enabling rename or synthesizing types', () => {
  const index = fixture({ a: define, b: 'define i32 @caller() {\n %x = call i32 @foo(i32 1)\n ret i32 %x\n}' });
  assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['a']);
  assert.equal(index.rename('b', position(index, 'b', '@foo'), 'bar'), undefined);
  assert.equal(index.references('b', position(index, 'b', '@foo')).length, 0);
  assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /unresolved reference/);
});

test('an exported new-name collision in a nonparticipating module also blocks rename', () => {
  const index = fixture({ a: define, b: caller, c: '@bar = global i32 0' });
  assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /already exists/);
  index.upsert('c', '@bar = private global i32 0', { root: 'project' });
  assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 3);
});

test('assembly-only references, linker-option strings and debug linkage names block unsafe rename', () => {
  for (const source of ['module asm "call foo"', '!llvm.linker.options = !{!0}\n!0 = !{!"/include:foo"}',
    '!0 = !DISubprogram(name: "display", linkageName: "foo")']) {
    const index = fixture({ a: define, b: caller, c: source });
    const plan = index.rename('a', position(index, 'a', '@foo'), 'bar');
    assert.equal(plan.edits.length, 0);
    assert.match(plan.error, /assembly|linker options|metadata/);
  }
  const index = fixture({ a: define, b: '!0 = !DISubprogram(name: "foo", linkageName: "other")' });
  assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 1);
});

test('empty quoted names are valid named globals, distinct from numbered slots', () => {
  const index = fixture({ a: define, b: caller });
  const plan = index.rename('a', position(index, 'a', '@foo'), '@""');
  assert.equal(plan.error, undefined);
  assert.equal(plan.edits.length, 3);
  assert.ok(plan.edits.every(edit => edit.newText === '@""'));
  index.upsert('a', define.replace('@foo', '@""'), { root: 'project' });
  index.upsert('b', caller.replaceAll('@foo', '@""'), { root: 'project' });
  assert.equal(index.rename('a', position(index, 'a', '@""'), 'foo').edits.length, 3);
});

test('missing target layout/triple is not treated as an ABI-compatible wildcard', () => {
  for (const [setting, value, definition, declaration] of [
    ['datalayout', 'P1', 'define void @foo() {\n ret void\n}', 'declare void @foo()'],
    ['datalayout', 'G1', '@foo = global i32 0', '@foo = external global i32'],
    ['triple', 'x86_64-unknown-linux-gnu', define, caller]
  ]) {
    const index = fixture({ a: `target ${setting} = "${value}"\n${definition}`, b: declaration });
    assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['b']);
    assert.ok(index.references('a', position(index, 'a', '@foo')).every(item => item.uri === 'a'));
    assert.ok(index.references('b', position(index, 'b', '@foo')).every(item => item.uri === 'b'));
    const plan = index.rename('a', position(index, 'a', '@foo'), 'bar');
    assert.equal(plan.edits.length, 0);
    assert.match(plan.error, /ABI|triples|layouts/);
  }
});

test('effective P/G address spaces compare implicit defaults and explicit overrides', () => {
  for (const [layout, definition, declaration, explicit] of [
    ['P1', 'define void @foo() {\n ret void\n}', 'declare void @foo()', space => `declare void @foo() addrspace(${space})`],
    ['G1', '@foo = global i32 0', '@foo = external global i32', space => `@foo = external addrspace(${space}) global i32`]
  ]) {
    const header = `target datalayout = "${layout}"\n`;
    const index = fixture({ a: header + definition, b: header + declaration });
    assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 2);
    index.upsert('b', header + explicit(1), { root: 'project' });
    assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['a']);
    assert.equal(index.rename('a', position(index, 'a', '@foo'), 'bar').edits.length, 2);
    index.upsert('b', header + explicit(0), { root: 'project' });
    assert.deepEqual(index.definitions('b', position(index, 'b', '@foo')).map(item => item.uri), ['b']);
    assert.equal(index.references('a', position(index, 'a', '@foo')).length, 1);
    assert.match(index.rename('a', position(index, 'a', '@foo'), 'bar').error, /ABI/);
  }
});
