'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { analyze } = require('../src/analysis');
const { checkIR, suggest } = require('../src/checks');
const { courseFile, courseSkip } = require('./course-files');

const check = text => checkIR(analyze(text));
const serious = issues => issues.filter(issue => issue.severity === 'error' || issue.severity === 'warning');
const llvmAs = spawnSync('llvm-as', ['--version']).status === 0;
const assemble = ir => spawnSync('llvm-as', ['-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-'], { input: ir }).status;

// [expected code or null, severity, IR]. Errors are exactly what llvm-as
// rejects; warnings and hints flag IR it accepts; null rows are valid IR that
// must produce no error or warning.
const f = body => `define i32 @f(i32 %a, ptr %p) {\nentry:\n${body}\n}\n`;
const cases = [
  ['undefined-value', 'error', f('  %x = add i32 %b, 1\n  ret i32 %x')],
  ['undefined-value', 'error', f('  %x = call i32 @g(i32 1)\n  ret i32 %x')],
  ['undefined-value', 'error', 'define i32 @f() {\n  %1 = add i32 1, 2\n  ret i32 %5\n}\n'],
  ['undefined-label', 'error', f('  br label %exit\nexti:\n  ret i32 0')],
  ['undefined-type', 'error', f('  %x = alloca %T\n  ret i32 0')],
  ['undefined-metadata', 'error', f('  ret i32 0, !dbg !7')],
  ['undefined-attributes', 'warning', 'define void @g() #3 {\n  ret void\n}\n'],
  ['duplicate-definition', 'error', f('  %x = add i32 %a, 1\n  %x = add i32 %a, 2\n  ret i32 %x')],
  ['duplicate-definition', 'error', f('  br label %a\na:\n  ret i32 0')],
  ['duplicate-definition', 'error', 'declare void @g()\ndefine void @g() {\n  ret void\n}\n'],
  ['duplicate-definition', 'error', '@g = global i32 0\n@g = global i32 1\n'],
  ['numbering', 'error', 'define i32 @f() {\n  %0 = add i32 1, 2\n  ret i32 %0\n}\n'],
  ['numbering', 'error', 'define i32 @f(i32) {\n  %0 = add i32 1, 2\n  ret i32 %0\n}\n'],
  ['numbering', 'error', 'define i32 @f() {\n  %1 = add i32 1, 2\n  call i32 @f()\n  %2 = add i32 1, 2\n  ret i32 %2\n}\n'],
  ['missing-terminator', 'error', f('  %x = add i32 %a, 1\nnext:\n  ret i32 %x')],
  ['missing-terminator', 'error', f('  br label %next\nnext:')],
  ['empty-body', 'error', 'define void @g() {\n}\n'],
  ['missing-body', 'error', 'define void @g()\n'],
  ['unclosed-body', 'error', 'define void @g() {\n  ret void\n'],
  ['entry-branch', 'error', f('  br label %entry')],
  ['not-a-label', 'error', f('  %x = add i32 %a, 1\n  br label %x')],
  ['phi-position', 'error', f('  br label %b\nb:\n  %y = add i32 %a, 1\n  %x = phi i32 [ 0, %entry ]\n  ret i32 %x')],
  ['phi-predecessors', 'error', f('  br label %b\nc:\n  br label %b\nb:\n  %x = phi i32 [ 0, %entry ]\n  ret i32 %x')],
  ['phi-predecessors', 'error', f('  br label %b\nb:\n  %x = phi i32 [ 0, %entry ], [ 1, %c ]\n  ret i32 %x\nc:\n  ret i32 0')],
  ['dominance', 'error', f('  %c = icmp eq i32 %a, 0\n  br i1 %c, label %t, label %j\nt:\n  %y = add i32 %a, 1\n  br label %j\nj:\n  ret i32 %y')],
  ['dominance', 'error', f('  %x = add i32 %y, 1\n  %y = add i32 %a, 1\n  ret i32 %x')],
  ['dominance', 'error', f('  %x = add i32 %x, 1\n  ret i32 %x')],
  ['return-type', 'error', f('  ret void')],
  ['return-type', 'error', f('  ret i64 0')],
  ['void-result', 'error', f('  %s = store i32 1, ptr %p\n  ret i32 0')],
  ['void-result', 'error', 'declare void @g()\n' + f('  %r = call void @g()\n  ret i32 0')],
  ['type-mismatch', 'error', f('  %w = sext i32 %a to i64\n  %x = add i32 %a, %w\n  ret i32 %x')],
  ['type-mismatch', 'error', f('  %x = add i32 %p, 1\n  ret i32 %x')],
  ['type-mismatch', 'error', f('  store i64 %a, ptr %p\n  ret i32 0')],
  ['type-mismatch', 'error', f('  ret i32 %p')],
  ['unknown-instruction', 'error', f('  %x = ad i32 %a, 1\n  ret i32 %x')],
  ['unknown-instruction', 'error', f('  stor i32 1, ptr %p\n  ret i32 0')],
  ['memory-operands', 'error', f('  store ptr %p, i32 %a\n  ret i32 0')],
  ['call-signature', 'warning', 'declare i32 @g(i32)\n' + f('  %x = call i32 @g(i32 1, i32 2)\n  ret i32 %x')],
  ['call-signature', 'warning', 'declare i32 @g(i32)\n' + f('  %x = call i32 @g(i64 1)\n  ret i32 %x')],
  ['variadic-call', 'warning', 'declare i32 @printf(ptr, ...)\n' + f('  %x = call i32 @printf(ptr %p)\n  ret i32 %x')],
  ['division-by-zero', 'warning', f('  %x = sdiv i32 %a, 0\n  ret i32 %x')],
  ['unreachable-code', 'warning', f('  ret i32 0\n  ret i32 1')],
  ['unreachable-block', 'hint', f('  ret i32 0\ndead:\n  ret i32 1')],
  ['unused-value', 'hint', f('  %x = add i32 %a, 1\n  ret i32 0')],
  ['unused-declaration', 'hint', 'declare void @g()\n' + f('  ret i32 0')],
  ['unused-private', 'hint', '@s = private constant i32 1\n' + f('  ret i32 0')],
  [null, null, 'define i32 @f() {\n  %2 = add i32 1, 2\n  ret i32 %2\n}\n'],
  [null, null, 'define i32 @f() {\n  %1 = add i32 1, 2\n  call i32 @f()\n  %3 = add i32 1, 2\n  br label %4\n4:\n  ret i32 %3\n}\n'],
  [null, null, 'define i32 @f(i32, i32) {\n  %3 = add i32 %0, %1\n  ret i32 %3\n}\n'],
  [null, null, 'declare i32 @printf(ptr, ...)\n@s = constant [3 x i8] c"hi\\00"\ndefine i32 @main() {\n  %1 = call i32 (ptr, ...) @printf(ptr @s)\n  call i32 (ptr, ...) @printf(ptr @s)\n  %3 = add i32 %1, 1\n  ret i32 %3\n}\n'],
  [null, null, f('  br label %loop\nloop:\n  %i = phi i32 [ 0, %entry ], [ %n, %loop ]\n  %n = add i32 %i, 1\n  %c = icmp slt i32 %n, %a\n  br i1 %c, label %loop, label %done\ndone:\n  ret i32 %n')],
  [null, null, f('  switch i32 %a, label %d [\n    i32 0, label %z\n    i32 1, label %z\n  ]\nz:\n  %r = phi i32 [ 1, %entry ], [ 1, %entry ]\n  ret i32 %r\nd:\n  ret i32 0')],
  [null, null, f('  %s = alloca { i32, [4 x i8] }\n  %g = getelementptr { i32, [4 x i8] }, ptr %s, i32 0, i32 1, i64 2\n  store i8 1, ptr %g\n  %v = load i8, ptr %g\n  %w = zext i8 %v to i32\n  ret i32 %w')],
  [null, null, 'define noundef range(i32 0, 10) i32 @f(i32 noundef %a) {\n  ret i32 %a\n}\n'],
];

test('each built-in check reports its case, and valid IR stays clean', () => {
  for (const [code, severity, ir] of cases) {
    const issues = check(ir);
    if (!code) { assert.deepEqual(serious(issues).map(issue => issue.message), [], ir); continue; }
    assert.ok(issues.some(issue => issue.code === code && issue.severity === severity), `${code} in\n${ir}\n${JSON.stringify(issues)}`);
    if (severity !== 'error') assert.ok(!issues.some(issue => issue.severity === 'error'), `no error for accepted IR:\n${ir}`);
  }
});

test('built-in errors are exactly the cases llvm-as rejects', { skip: !llvmAs && 'llvm-as is not installed' }, () => {
  for (const [, severity, ir] of cases) assert.equal(assemble(ir) !== 0, severity === 'error', ir);
});

const homework = ['hw0/fact1.llvm', 'hw0/fact2.llvm', 'hw0/fib.llvm', 'hw0/max.llvm', 'hw2/objects.llvm'];
test('course files have no built-in errors; hw2 printf calls lack the variadic type', { skip: courseSkip(...homework) }, () => {
  for (const name of homework) {
    const issues = check(courseFile(name));
    assert.deepEqual(issues.filter(issue => issue.severity === 'error').map(issue => issue.message), [], name);
  }
  const hw2 = check(courseFile('hw2/objects.llvm'));
  assert.deepEqual([...new Set(serious(hw2).map(issue => issue.code))], ['variadic-call']);
  assert.equal(hw2.find(issue => issue.code === 'variadic-call').insert.text, '(i8*, ...) ');
});

test('clang-style IR with exceptions, switch tables and numbered values stays clean', () => {
  const ir = [
    '%struct.S = type { i32, ptr }',
    '@.str = private unnamed_addr constant [4 x i8] c"%d\\0A\\00", align 1',
    '@_ZTIi = external constant ptr',
    'declare i32 @printf(ptr noundef, ...) #1',
    'declare i32 @__gxx_personality_v0(...)',
    'declare void @may_throw(i32)',
    'define dso_local noundef i32 @f(i32 noundef %0) #0 personality ptr @__gxx_personality_v0 {',
    '  %2 = alloca i32, align 4',
    '  store i32 %0, ptr %2, align 4',
    '  %3 = load i32, ptr %2, align 4',
    '    #dbg_value(i32 %3, !9, !DIExpression(), !10)',
    '  switch i32 %3, label %7 [',
    '    i32 0, label %4',
    '    i32 1, label %5',
    '  ]',
    '',
    '4:                                                ; preds = %1',
    '  invoke void @may_throw(i32 1)',
    '          to label %5 unwind label %6',
    '',
    '5:                                                ; preds = %4, %1',
    '  %call = call i32 (ptr, ...) @printf(ptr noundef @.str, i32 noundef %3)',
    '  br label %7',
    '',
    '6:                                                ; preds = %4',
    '  %lp = landingpad { ptr, i32 }',
    '          cleanup',
    '          catch ptr @_ZTIi',
    '  resume { ptr, i32 } %lp',
    '',
    '7:                                                ; preds = %5, %1',
    '  %8 = phi i32 [ 0, %1 ], [ %call, %5 ]',
    '  ret i32 %8',
    '}',
    'attributes #0 = { noinline }',
    'attributes #1 = { nounwind }',
    '!llvm.module.flags = !{!0}',
    '!0 = !{i32 2, !"Debug Info Version", i32 3}',
    '!8 = distinct !DISubprogram(name: "f", unit: !11)',
    '!9 = !DILocalVariable(name: "v", scope: !8)',
    '!10 = !DILocation(line: 1, scope: !8)',
    '!11 = distinct !DICompileUnit(language: DW_LANG_C11, file: !12, emissionKind: FullDebug)',
    '!12 = !DIFile(filename: "a.c", directory: "/")',
    ''
  ].join('\n');
  assert.deepEqual(serious(check(ir)).map(issue => issue.message), []);
  if (llvmAs) assert.equal(assemble(ir), 0);
});

test('messages name the fix: suggestions, lines, and related definitions', () => {
  const [misspelled] = check('define i32 @f(i32 %count) {\n  ret i32 %cuont\n}\n');
  assert.equal(misspelled.message, 'Value %cuont is not defined in @f. Did you mean %count?');
  assert.equal(misspelled.replacement, '%count');
  const typo = check('define i32 @f(i32 %a) {\n  %x = ad i32 %a, 1\n  ret i32 %x\n}\n').find(issue => issue.code === 'unknown-instruction');
  assert.equal(typo.replacement, 'add');
  const duplicate = check('@g = global i32 0\n@g = global i32 1\n').find(issue => issue.code === 'duplicate-definition');
  assert.match(duplicate.message, /already defined on line 1/);
  assert.equal(duplicate.related[0].start, 0);
  const mismatch = check('define i32 @f(i64 %w) {\n  %x = add i32 1, %w\n  ret i32 %x\n}\n').find(issue => issue.code === 'type-mismatch');
  assert.equal(mismatch.message, '%w has type i64, but i32 is expected here.');
  const unused = check('define i32 @f(i32 %a) {\n  %x = add i32 %a, 1\n  ret i32 0\n}\n').find(issue => issue.code === 'unused-value');
  assert.equal(unused.unnecessary, true);
  assert.equal(suggest('%zzz', ['%a', '%b']), undefined, 'unrelated names are not suggested');
});
