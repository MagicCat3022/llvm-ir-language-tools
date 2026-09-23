'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/analysis');
const { lookupLibrary, listLibraries } = require('../src/library');
const declared = text => analyze(text).symbols.find(symbol => symbol.kind === 'function');
const help = text => { const symbol = declared(text); assert.ok(symbol, text); return lookupLibrary(symbol.name, symbol); };
const allText = entry => [entry.summary, entry.returns, ...entry.notes, entry.details || '', ...entry.parameters.map(p => p.description)].join('\n');

test('catalog covers common libc with useful behavior, parameters and primary links', () => {
  const expected = ['printf', 'fprintf', 'sprintf', 'snprintf', 'puts', 'putchar', 'scanf', 'fscanf', 'sscanf', 'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'strlen', 'strcmp', 'exit', 'abort'];
  for (const name of expected) {
    const entry = lookupLibrary('@' + name);
    assert.equal(entry.name, name);
    assert.equal(entry.category, 'libc');
    assert.match(entry.notes.join(' '), /actual declaration and target govern the ABI/);
    assert.equal(entry.signature, undefined);
  }
  const entries = listLibraries();
  assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length);
  for (const entry of entries) {
    assert.ok(entry.summary.length > 10, entry.name);
    assert.ok(entry.returns.length > 0, entry.name);
    assert.ok(entry.parameters.every(p => p.name && p.description), entry.name);
    assert.match(entry.url, /^https:\/\/(?:pubs\.opengroup\.org\/onlinepubs\/9799919799\/functions\/[a-z]+\.html|llvm\.org\/docs\/(?:LangRef|SourceLevelDebugging)\.html#[\w-]+)$/);
    assert.ok(Object.isFrozen(entry));
  }
  entries.pop();
  assert.equal(listLibraries().length, entries.length + 1);
});

test('printf catalog explains conversions, promotions, ABI and format hazards', () => {
  const entry = help('declare i32 @printf(ptr, ...)');
  assert.ok(entry);
  for (const expected of ['%d', '%i', '%u', '%o', '%x', '%X', '%f', '%e', '%g', '%a', '%c', '%s', '%p', '%n', '%%', '%zu', '%ld', 'LP64', 'LLP64', 'double', '.*', 'hh', 'll', 'precision']) assert.ok(entry.details.includes(expected), expected);
  assert.match(entry.details, /width.*not a buffer bound/i);
  assert.match(entry.details, /untrusted text/);
  assert.match(entry.details, /float becomes double/);
  assert.ok(help('declare i32 @fprintf(ptr, ptr, ...)'));
  assert.ok(help('declare i32 @sprintf(i8*, i8*, ...)'));
  assert.ok(help('declare i32 @snprintf(ptr, i64, ptr, ...)'));
});

test('formatted input uses its own pointer, width, precision and return rules', () => {
  for (const name of ['scanf', 'fscanf', 'sscanf']) {
    const entry = help(`declare i32 @${name}(${name === 'scanf' ? 'ptr' : 'ptr, ptr'}, ...)`);
    assert.ok(entry);
    assert.match(entry.details, /`float \*`.*`%lf`.*`double \*`/);
    assert.match(entry.details, /suppresses assignment/);
    assert.match(entry.details, /no printf-style precision/);
    assert.match(entry.details, /`void \*\*`/);
    assert.match(entry.details, /does not increment assignment count/);
    assert.match(entry.returns, /assignments.*EOF/);
    assert.notEqual(entry.details, lookupLibrary('printf').details);
  }
});

test('memory, string and return-count caveats are not flattened into generic help', () => {
  assert.match(allText(lookupLibrary('snprintf')), /would have been written.*excluding the terminator/);
  assert.match(allText(lookupLibrary('snprintf')), /not necessarily the stored count/);
  assert.match(allText(lookupLibrary('memcpy')), /Overlapping copies have undefined behavior/);
  assert.match(allText(lookupLibrary('memmove')), /permitting overlap/);
  assert.match(allText(lookupLibrary('realloc')), /nonzero requested size.*failure leaves the original allocation intact/);
  assert.match(allText(lookupLibrary('calloc')), /not a portable guarantee of null pointers/);
  assert.match(allText(lookupLibrary('puts')), /not a portable byte count/);
  assert.match(allText(lookupLibrary('strcmp')), /Only the sign is portable/);
  assert.match(allText(lookupLibrary('strlen')), /not Unicode characters/);
  assert.match(allText(lookupLibrary('abort')), /Do not depend on buffered output being flushed/);
});

test('libc matching requires a compatible external function declaration', () => {
  for (const text of [
    'declare i32 @printf()', 'declare i32 @printf(ptr)', 'declare i32 @printf(i32, ...)',
    'declare ptr @printf(ptr, ...)', 'declare i1 @printf(ptr, ...)',
    'declare internal i32 @printf(ptr, ...)', 'declare private i32 @printf(ptr, ...)',
    'declare fastcc i32 @printf(ptr, ...)', 'declare cc 8 i32 @printf(ptr, ...)',
    'declare i32 @printf(ptr byval(i8), ...)',
    'define i32 @printf(ptr %format, ...) { ret i32 0 }',
    'declare i32 @malloc(i64)', 'declare ptr @malloc(ptr)',
    'declare ptr @memcpy(ptr, ptr, i1)', 'declare void @free(ptr, ...)',
    'declare void @exit()', 'declare i32 @abort()'
  ]) assert.equal(help(text), undefined, text);
  assert.ok(help('declare external i32 @printf(ptr, ...)'));
  assert.ok(help('declare ccc i32 @printf(ptr, ...)'));
  assert.ok(help('declare dso_local i32 @printf(ptr noundef, ...)'));
  assert.ok(help('declare i16 @printf(i8*, ...)'));
  assert.ok(help('declare ptr @malloc(i32)'));
  assert.ok(help('declare i8* @realloc(i8*, i64)'));
  assert.ok(help('declare i32 @fprintf(%struct.FILE*, i8*, ...)'));
  assert.equal(lookupLibrary('@printf', { ...declared('declare i32 @printf(ptr, ...)'), kind: 'global' }), undefined);
  assert.equal(lookupLibrary('@printf', declared('declare i32 @custom(ptr, ...)')), undefined);
});

test('exact names accept LLVM byte escapes but reject aliases, mangling and unsafe inputs', () => {
  for (const name of ['printf', '@printf', '@"printf"', '@"\\70rintf"', '"printf"']) assert.equal(lookupLibrary(name).name, 'printf');
  assert.ok(help(String.raw`declare i32 @"\70rintf"(ptr, ...)`));
  for (const name of ['Printf', '@PRINTF', '@0', '@"0"', '@"\\01printf"', '@_printf', '@__printf_chk', '@printf@GLIBC_2.2.5', '@printf.extra', '@"printf', '@"printf\\x"', '@"printf"junk', '%printf', 'constructor', '__proto__', 'toString', null, undefined, 3, {}, 'x'.repeat(10000)]) assert.equal(lookupLibrary(name), undefined, String(name));
  const alias = analyze('@printf = alias i32 (ptr, ...), ptr @other').symbols[0];
  assert.equal(lookupLibrary('@printf', alias), undefined);
});

test('memory intrinsic encodings match pointer address spaces and actual integer lengths', () => {
  for (const text of [
    'declare void @llvm.memcpy.p0.p0.i64(ptr, ptr, i64, i1)',
    'declare void @llvm.memmove.p1.p3.i32(ptr addrspace(1), ptr addrspace(3), i32, i1)',
    'declare void @llvm.memset.p0.i64(ptr, i8, i64, i1)',
    'declare void @llvm.memcpy.p0i8.p0i8.i32(i8*, i8*, i32, i1)',
    'declare void @llvm.memset.p2i8.i64(i8 addrspace(2)*, i8, i64, i1)'
  ]) assert.ok(help(text), text);
  assert.match(allText(lookupLibrary('llvm.memcpy.p0.p0.i64')), /equal or non-overlapping/);
  for (const name of [
    'llvm.memcpy', 'llvm.memcpy.p0.p0', 'llvm.memcpy.p0.p0.i64.extra',
    'llvm.memcpy.inline.p0.p0.i64', 'llvm.memcpy.element.unordered.atomic.p0.p0.i64',
    'llvm.memmove.inline.p0.p0.i64', 'llvm.memset.inline.p0.i64',
    'llvm.memset.element.unordered.atomic.p0.i64',
    'llvm.memcpy.p0.p0.v2i64', 'llvm.memcpy.p0.p0.i0',
    'llvm.memcpy.p16777216.p0.i64', 'llvm.memcpy.p0i32.p0i8.i64',
    'llvm.memset.p0.i64.p0', 'llvm.memcpy.p00.p0.i64'
  ]) assert.equal(lookupLibrary(name), undefined, name);
  assert.equal(help('declare void @llvm.memcpy.p1.p0.i64(ptr, ptr, i64, i1)'), undefined);
  assert.equal(help('declare ptr @llvm.memcpy.p0.p0.i64(ptr, ptr, i64, i1)'), undefined);
  assert.equal(help('declare void @llvm.memset.p0.i64(ptr, i32, i64, i1)'), undefined);
});

test('lifetime docs handle modern and historical prototypes without guessing a version', () => {
  for (const phase of ['start', 'end']) {
    for (const text of [
      `declare void @llvm.lifetime.${phase}(ptr)`,
      `declare void @llvm.lifetime.${phase}(i64, i8*)`,
      `declare void @llvm.lifetime.${phase}.p0(i64, ptr)`,
      `declare void @llvm.lifetime.${phase}.p0i8(i64, i8*)`
    ]) assert.ok(help(text), text);
    assert.match(allText(lookupLibrary(`llvm.lifetime.${phase}`)), /one pointer argument/);
    assert.equal(help(`declare void @llvm.lifetime.${phase}.p0(ptr)`), undefined);
    assert.equal(lookupLibrary(`llvm.lifetime.${phase}.p0.extra`), undefined);
  }
});

test('debug records remain distinct from legacy intrinsic declarations', () => {
  for (const kind of ['value', 'declare']) {
    const entry = help(`declare void @llvm.dbg.${kind}(metadata, metadata, metadata)`);
    assert.ok(entry);
    assert.match(allText(entry), new RegExp('#dbg_' + kind));
    assert.match(allText(entry), /not ordinary call instructions/);
    assert.equal(help(`declare void @llvm.dbg.${kind}(ptr)`), undefined);
    assert.equal(lookupLibrary(`llvm.dbg.${kind}.p0`), undefined);
  }
});

test('integer and floating overloads support scalar, fixed and scalable vectors safely', () => {
  for (const text of [
    'declare i37 @llvm.ctpop.i37(i37)',
    'declare <4 x i32> @llvm.ctlz.v4i32(<4 x i32>, i1)',
    'declare <vscale x 2 x i64> @llvm.cttz.nxv2i64(<vscale x 2 x i64>, i1)',
    'declare <4 x i48> @llvm.bswap.v4i48(<4 x i48>)',
    'declare float @llvm.sqrt.f32(float)',
    'declare double @llvm.sqrt.f64(double)',
    'declare <vscale x 2 x half> @llvm.fabs.nxv2f16(<vscale x 2 x half>)',
    'declare <2 x bfloat> @llvm.fabs.v2bf16(<2 x bfloat>)',
    'declare ppc_fp128 @llvm.fabs.ppcf128(ppc_fp128)'
  ]) assert.ok(help(text), text);
  for (const name of ['llvm.ctpop.i0', 'llvm.ctpop.i8388608', 'llvm.ctpop.v0i32', 'llvm.ctpop.v1048577i32', 'llvm.ctpop.v4f32', 'llvm.ctpop.i32.suffix', 'llvm.bswap.i8', 'llvm.bswap.i24', 'llvm.sqrt.f33', 'llvm.sqrt.v4i32', 'llvm.sqrt.nxv0f32', 'llvm.sqrt.constrained.f64', 'llvm.experimental.constrained.sqrt.f64']) assert.equal(lookupLibrary(name), undefined, name);
  assert.equal(help('declare i64 @llvm.ctpop.i32(i32)'), undefined);
  assert.equal(help('declare <4 x i32> @llvm.ctlz.v4i32(<4 x i32>, <4 x i1>)'), undefined);
  assert.match(allText(lookupLibrary('llvm.ctlz.i32')), /zero input produces poison/);
});

test('overflow families verify complete struct and matching vector flag types', () => {
  for (const operation of ['sadd', 'uadd', 'ssub', 'usub', 'smul', 'umul']) {
    assert.ok(help(`declare {i32, i1} @llvm.${operation}.with.overflow.i32(i32, i32)`));
    assert.ok(help(`declare {<4 x i32>, <4 x i1>} @llvm.${operation}.with.overflow.v4i32(<4 x i32>, <4 x i32>)`));
    assert.ok(help(`declare {<vscale x 2 x i64>, <vscale x 2 x i1>} @llvm.${operation}.with.overflow.nxv2i64(<vscale x 2 x i64>, <vscale x 2 x i64>)`));
    assert.equal(help(`declare {<4 x i32>, i1} @llvm.${operation}.with.overflow.v4i32(<4 x i32>, <4 x i32>)`), undefined);
    assert.equal(lookupLibrary(`llvm.${operation}.with.overflow.f32`), undefined);
  }
});

test('assumptions, branch likelihood and traps retain distinct safety semantics', () => {
  assert.ok(help('declare void @llvm.assume(i1)'));
  assert.match(allText(lookupLibrary('llvm.assume')), /undefined behavior.*not a runtime assertion/);
  assert.ok(help('declare i32 @llvm.expect.i32(i32, i32)'));
  assert.ok(help('declare i1 @llvm.expect.with.probability.i1(i1, i1, double)'));
  assert.equal(lookupLibrary('llvm.expect.v2i32'), undefined);
  assert.equal(lookupLibrary('llvm.expect.with.probability.i1.extra'), undefined);
  assert.equal(help('declare i1 @llvm.expect.with.probability.i1(i1, i1, float)'), undefined);
  assert.ok(help('declare void @llvm.trap()'));
  assert.ok(help('declare void @llvm.debugtrap()'));
  assert.match(lookupLibrary('llvm.trap').returns, /Does not return/);
  assert.match(lookupLibrary('llvm.debugtrap').returns, /not inherently noreturn/);
  assert.equal(lookupLibrary('llvm.trap.i32'), undefined);
});
