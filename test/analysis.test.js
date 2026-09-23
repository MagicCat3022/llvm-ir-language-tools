'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { courseFile, courseSkip } = require('./course-files');
const { dominatorTree, analyze, tokenAt, symbolAt, references, visibleSymbols, callAt, formatIR } = require('../src/analysis');

const named = (analysis, name, scope) => analysis.symbols.find(entry => entry.name === name && (scope === undefined || entry.scope === scope));

test('course LLVM examples: forward calls, SSA types, signatures, globals', { skip: courseSkip('hw0/fib.llvm', 'hw0/max.llvm', 'hw0/fact1.llvm', 'hw0/fact2.llvm') }, () => {
  for (const name of ['fib.llvm', 'max.llvm', 'fact1.llvm', 'fact2.llvm']) {
    const text = courseFile('hw0/' + name);
    const analysis = analyze(text);
    assert.ok(named(analysis, '@main'));
    assert.equal(named(analysis, '@printf').returnType, 'i32');
    assert.equal(named(analysis, '@printf').variadic, true);
    assert.equal(named(analysis, '@msg').type, '[9 x i8]');
    assert.equal(formatIR(formatIR(text)), formatIR(text));
    assert.equal(analysis.symbols.filter(entry => entry.kind === 'variable' && entry.type === 'unknown').length, 0, name);
  }
  const text = courseFile('hw0/max.llvm');
  const analysis = analyze(text);
  const signature = callAt(analysis, text.indexOf('i32 10'));
  assert.equal(signature.symbol.name, '@max');
  assert.equal(signature.activeParameter, 1);
  assert.equal(named(analysis, '%t3', '@max').type, 'i32');
  assert.equal(named(analysis, '%t0', '@max').type, 'i1');
});

test('references preserve function scope and exclude strings/comments', () => {
  const text = '%T = type { i32, ptr }\n@str = constant [9 x i8] c"%x @f !0"\ndefine i32 @f(i32 %x) {\nentry:\n %T = add i32 %x, %x ; %x\n %v = alloca %T\n br label %done\ndone:\n ret i32 %T\n}\ndefine i32 @g(i32 %x) {\nentry:\n %v = add i32 %x, %x\n ret i32 %v\n}\n';
  const analysis = analyze(text);
  const x = named(analysis, '%x', '@f');
  assert.equal(references(analysis, x).length, 3);
  assert.equal(references(analysis, x, false).length, 2);
  assert.equal(references(analysis, named(analysis, '%T', null)).length, 2);
  assert.equal(references(analysis, named(analysis, '%T', '@f')).length, 2);
  assert.equal(symbolAt(analysis, text.indexOf('alloca %T') + 7).scope, null);
  assert.equal(references(analysis, named(analysis, '%done', '@f')).length, 2);
  assert.equal(symbolAt(analysis, text.indexOf('; %x') + 3), undefined);
  assert.equal(symbolAt(analysis, text.indexOf('c"%x') + 3), undefined);
  assert.equal(tokenAt(analysis, text.indexOf('add i32') + 3), undefined);
  const visible = visibleSymbols(analysis, text.indexOf('ret i32 %T'));
  assert.ok(visible.some(entry => entry.name === '@g'));
  assert.ok(visible.some(entry => entry.name === '%x' && entry.scope === '@f'));
  assert.ok(!visible.some(entry => entry.scope === '@g'));
});

test('quoted names, numeric and quoted labels retain exact definition spans', () => {
  const text = 'define i32 @"f\\22 x"(i32 %"arg x") {\n"block x":\n %"v\\22 x" = add i32 %"arg x", 1\n br label %2\n2:\n ret i32 %"v\\22 x"\n}';
  const analysis = analyze(text);
  const fn = named(analysis, '@"f\\22 x"');
  assert.equal(fn.parameters[0].name, '%"arg x"');
  const label = named(analysis, '%"block x"');
  assert.equal(text.slice(label.start, label.end), '"block x"');
  assert.equal(references(analysis, named(analysis, '%2')).length, 2);
  assert.equal(references(analysis, named(analysis, '%"v\\22 x"')).length, 2);
  assert.equal(analysis.functions[0].bodyStart, text.indexOf('{') + 1);
  assert.equal(analysis.functions[0].bodyEnd, text.lastIndexOf('}'));
});

test('blockaddress resolves labels in the explicitly named function from any scope', () => {
  const text = `@address = constant ptr blockaddress(@"target", %"done")
define void @target() {
entry:
 br label %done
done:
 ret void
}
define ptr @other() {
done:
 %address = select i1 true, ptr blockaddress(
   @target, ; a multiline constant
   %done), ptr blockaddress(@missing, %done)
 ret ptr %address
}`;
  const analysis = analyze(text);
  const target = named(analysis, '%done', '@target');
  assert.equal(symbolAt(analysis, text.indexOf('%"done"')), target);
  assert.equal(symbolAt(analysis, text.indexOf('%done), ptr')), target);
  assert.equal(symbolAt(analysis, text.lastIndexOf('%done)')), undefined);
  assert.equal(references(analysis, target).length, 4);
  assert.equal(references(analysis, named(analysis, '%done', '@other')).length, 1);
});

test('equivalent name spellings share identity while retaining source spans and function scope', () => {
  const text = String.raw`declare i32 @f(i32 %"x")
define i32 @"\66"(i32 %x) {
entry:
 %sum = add i32 %"x", %"\78"
 br label %"\65xit"
exit:
 ret i32 %sum
}
define i32 @g(i32 %"x") {
entry:
 %sum = add i32 %x, %"\78"
 %result = call i32 @"f"(i32 %sum)
 ret i32 %result
}`;
  const analysis = analyze(text);
  const fn = symbolAt(analysis, text.indexOf('@f'));
  assert.equal(fn.name, '@"\\66"');
  assert.equal(fn.declaration, false);
  assert.equal(references(analysis, fn).length, 3);
  assert.equal(callAt(analysis, text.indexOf('i32 %sum)')).symbol, fn);
  const x = named(analysis, '%x', '@"\\66"');
  const spans = references(analysis, x);
  assert.deepEqual(spans.map(span => text.slice(span.start, span.end)), ['%"x"', '%x', '%"x"', '%"\\78"']);
  assert.equal(references(analysis, x, false).length, 2);
  assert.ok(spans.every(span => span.start < text.indexOf('define i32 @g')));
  assert.equal(references(analysis, named(analysis, '%"x"', '@g')).length, 3);
  assert.equal(references(analysis, named(analysis, '%exit')).length, 2);
  const visible = visibleSymbols(analysis, text.indexOf('%sum = add'));
  assert.equal(visible.filter(entry => entry.kind === 'function' && entry.name !== '@g').length, 1);
  assert.equal(visible.filter(entry => entry.kind === 'parameter').length, 1);
});

test('quoted UTF-8 names match hex bytes and quoted numeric names remain separate from slot IDs', () => {
  const text = String.raw`%T = type { i32 }
declare i32 @0()
declare i32 @"0"()
define i32 @f(i32 %0, i32 %"0", i32 %"é") {
entry:
 %numeric = add i32 %0, %"\30"
 %unicode = add i32 %"\C3\a9", %"é"
 %field = extractvalue %"\54" zeroinitializer, 0
 %a = call i32 @0()
 %b = call i32 @"\30"()
 ret i32 %unicode
}`;
  const analysis = analyze(text);
  assert.equal(references(analysis, named(analysis, '%0')).length, 2);
  assert.equal(references(analysis, named(analysis, '%"0"')).length, 2);
  assert.equal(references(analysis, named(analysis, '%"é"')).length, 3);
  assert.equal(references(analysis, named(analysis, '@0')).length, 2);
  assert.equal(references(analysis, named(analysis, '@"0"')).length, 2);
  assert.equal(references(analysis, named(analysis, '%T')).length, 2);
  assert.equal(named(analysis, '%field').type, 'i32');
  assert.equal(symbolAt(analysis, text.indexOf('%"\\C3')).name, '%"é"');
});

test('multiline headers and calls use nested-comma active parameter counts', () => {
  const text = 'declare %Result @make(\n { i32, i32 },\n ptr,\n ...\n) nounwind\n%Result = type { i32, ptr }\ndefine %Result @run(\n ptr %p\n) #0 {\n %v = call %Result @make(\n { i32, i32 } { i32 1, i32 2 },\n ptr getelementptr ([3 x i8], ptr @s, i64 0, i64 1),\n i32 8\n )\n %w = call %Result @make({ i32, i32 } zeroinitializer, ptr %p)\n ret %Result %w\n}\n';
  const analysis = analyze(text);
  assert.equal(named(analysis, '@make').returnType, '%Result');
  assert.equal(named(analysis, '%v').type, '%Result');
  assert.equal(callAt(analysis, text.indexOf('i32 2')).activeParameter, 0);
  assert.equal(callAt(analysis, text.indexOf('i64 1')).activeParameter, 1);
  assert.equal(callAt(analysis, text.indexOf('i32 8')).activeParameter, 2);
  assert.equal(callAt(analysis, text.indexOf('ptr %p)')).activeParameter, 1);
  assert.equal(callAt(analysis, text.indexOf('nounwind')), undefined);
  assert.equal(callAt(analysis, text.indexOf('ret %Result')), undefined);
  assert.equal(references(analysis, named(analysis, '%p')).length, 2);
});

test('definition wins over declaration and declaration references are optional', () => {
  const text = 'declare i32 @f(i32)\ndefine i32 @main() {\n %v = call i32 @f(i32 1)\n ret i32 %v\n}\ndefine i32 @f(i32 %x) {\n ret i32 %x\n}';
  const analysis = analyze(text);
  const target = symbolAt(analysis, text.indexOf('@f'));
  assert.equal(target.declaration, false);
  assert.equal(references(analysis, target).length, 3);
  assert.equal(references(analysis, target, false).length, 1);
  assert.equal(callAt(analysis, text.indexOf('i32 1')).symbol.parameters[0].name, '%x');
});

test('parameter attributes keep embedded named types separate from parameter names', () => {
  const text = '%Struct = type { i32 }\ndeclare void @unnamed(ptr byval(%Struct))\ndefine void @f(ptr byval(%Struct) align 8 %arg, ptr sret(%Struct) %out) {\n call void @unnamed(ptr byval(%Struct) %arg)\n ret void\n}';
  const analysis = analyze(text);
  assert.deepEqual(named(analysis, '@f').parameters.map(entry => entry.name), ['%arg', '%out']);
  assert.equal(named(analysis, '@unnamed').parameters[0].name, '');
  assert.equal(references(analysis, named(analysis, '%Struct')).length, 5);
  assert.equal(references(analysis, named(analysis, '%arg')).length, 2);
});

test('common operations infer aggregate/vector types and opaque address spaces', () => {
  const text = '%Record = type { i64, [2 x <4 x i16>] }\ndefine void @f(ptr addrspace(3) %p, <4 x i32> %vec) {\n %a = alloca i32, addrspace(5)\n %g = getelementptr i32, ptr addrspace(3) %p, i64 1\n %l = load i16, ptr addrspace(3) %p\n %cmp = icmp eq <4 x i32> %vec, zeroinitializer\n %cast = trunc <4 x i32> %vec to <4 x i16>\n %sel = select i1 true, ptr addrspace(3) %p, ptr addrspace(3) null\n %freeze = freeze <4 x i32> %vec\n %el = extractelement <4 x i32> %vec, i32 0\n %ins = insertelement <4 x i32> %vec, i32 1, i32 0\n %sh = shufflevector <4 x i32> %vec, <4 x i32> poison, <2 x i32> <i32 0, i32 2>\n %ex = extractvalue %Record zeroinitializer, 1, 0\n %iv = insertvalue %Record zeroinitializer, i64 2, 0\n %cx = cmpxchg ptr %p, i32 0, i32 1 seq_cst seq_cst\n %rmw = atomicrmw add ptr %p, i64 1 monotonic\n %fn = alloca i32 (i32, ptr)*\n ret void\n}';
  const analysis = analyze(text);
  const expected = { '%a': 'ptr addrspace(5)', '%g': 'ptr addrspace(3)', '%l': 'i16', '%cmp': '<4 x i1>', '%cast': '<4 x i16>', '%sel': 'ptr addrspace(3)', '%freeze': '<4 x i32>', '%el': 'i32', '%ins': '<4 x i32>', '%sh': '<2 x i32>', '%ex': '<4 x i16>', '%iv': '%Record', '%cx': '{ i32, i1 }', '%rmw': 'i64', '%fn': 'ptr' };
  for (const [name, type] of Object.entries(expected)) assert.equal(named(analysis, name).type, type, name);
  assert.equal(named(analysis, '%a').allocatedType, 'i32');
  assert.equal(named(analysis, '%fn').allocatedType, 'i32 (i32, ptr)*');
});

test('pointer access hints disappear for conflicting uses or escaped stack slots', () => {
  const header = `%A = type { i32 }
%B = type { i32 }
declare ptr @malloc(i64)
declare void @escape(ptr)
define void @useA(ptr %p) {
entry:
 %field = getelementptr %A, ptr %p, i32 0, i32 0
 ret void
}
define void @useB(ptr %p) {
entry:
 %field = getelementptr %B, ptr %p, i32 0, i32 0
 ret void
}
`;
  const body = extra => `define void @test() {
entry:
 %slot = alloca ptr
 %value = call ptr @malloc(i64 8)
 call void @useA(ptr %value)
 ${extra}
 store ptr %value, ptr %slot
 ret void
}`;
  const clear = analyze(header + body(''));
  assert.deepEqual(named(clear, '%slot').storedPointerAccess, { type: '%A', via: '@useA' });
  const conflicting = analyze(header + body('call void @useB(ptr %value)'));
  assert.equal(named(conflicting, '%value').accessType, undefined);
  assert.equal(named(conflicting, '%slot').storedPointerAccess, undefined);
  const escaped = analyze(header + body('call void @escape(ptr %slot)'));
  assert.equal(named(escaped, '%slot').storedPointerAccess, undefined);
  const overwritten = analyze(header + body('store ptr null, ptr %slot'));
  assert.equal(named(overwritten, '%slot').storedPointerAccess, undefined);
});

test('incomplete calls are useful while unsupported instructions stay unknown', () => {
  const text = 'declare i32 @f(i32, ptr)\ndefine void @g() {\n %x = mystery i32 4\n %v = call i32 @f(i32 1,\n  ';
  const analysis = analyze(text);
  assert.equal(named(analysis, '%x').type, 'unknown');
  assert.equal(callAt(analysis, text.length).activeParameter, 1);
  assert.doesNotThrow(() => analyze('define i32 @unfinished(\n'));
  assert.doesNotThrow(() => analyze('%T = type { i32,\n'));
});

test('formatter only changes edge whitespace and preserves CRLF and quoted bytes', () => {
  const text = '  @s = constant [8 x i8] c" hi  \\00"   \r\n  define void @f() {  \r\n  "hello  world":  \r\n\t\t; retain  internal comment spacing  \r\n       %x = add i32  1, 2  ; hello  there   \r\n   ret void\r\n   }  \r\n';
  const formatted = formatIR(text);
  assert.equal(formatted, '@s = constant [8 x i8] c" hi  \\00"\r\ndefine void @f() {\r\n"hello  world":\r\n  ; retain  internal comment spacing\r\n  %x = add i32  1, 2  ; hello  there\r\n  ret void\r\n}\r\n');
  assert.equal(formatIR(formatted), formatted);
  assert.ok(formatIR(text, { insertSpaces: false }).includes('\r\n\tret void'));
  assert.ok(formatIR(text, { tabSize: 4 }).includes('\r\n    ret void'));
  const partial = '@s = constant [8 x i8] c"hello\n  literal  \nworld"\n';
  assert.equal(formatIR(partial), partial);
});

test('dominator trees match the dataflow definition, with unreachable blocks dominated by all', () => {
  // Reference: the maximal fixpoint of dom(b) = {b} ∪ ⋂ dom(p) over predecessors.
  const reference = (count, predecessors) => {
    const sets = Array.from({ length: count }, (_, i) => new Set(i ? Array.from({ length: count }, (_, j) => j) : [0]));
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 1; i < count; i++) {
        if (!predecessors[i].length) continue;
        const next = new Set([i, ...[...sets[predecessors[i][0]]].filter(d => predecessors[i].every(p => sets[p].has(d)))]);
        if (next.size !== sets[i].size) { sets[i] = next; changed = true; }
      }
    }
    return sets;
  };
  let seed = 1;
  const random = limit => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  for (let trial = 0; trial < 500; trial++) {
    const count = 1 + random(9), predecessors = Array.from({ length: count }, () => []);
    for (let from = 0; from < count; from++) for (let k = random(3); k > 0; k--) predecessors[random(count)].push(from);
    const expected = reference(count, predecessors), { dominators } = dominatorTree(count, predecessors);
    for (let block = 0; block < count; block++) for (let d = 0; d < count; d++)
      assert.equal(dominators[block].has(d), expected[block].has(d), `${JSON.stringify(predecessors)}: ${d} dom ${block}`);
  }
});

test('checks of a long straight-line function stay fast', () => {
  const { checkIR } = require('../src/checks');
  let text = 'define i32 @f(i32 %x) {\nentry:\n  br label %b0\n';
  for (let i = 0; i < 3000; i++) text += `b${i}:\n  %v${i} = add i32 ${i ? `%v${i - 1}` : '%x'}, 1\n  br label %b${i + 1}\n`;
  text += 'b3000:\n  ret i32 %v2999\n}\n';
  const started = performance.now();
  assert.deepEqual(checkIR(analyze(text)), []);
  // Quadratic dominator sets took about a second here; the tree takes tens of ms.
  assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`);
});
