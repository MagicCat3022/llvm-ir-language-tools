'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseDiagnostics, verifyIR, probeLLVMAs, parseLLVMVersion, producerVersion } = require('../src/diagnostics');

test('parses positional errors, warnings, excerpts, and CRLF offsets', () => {
  const text = 'define i32 @main() {\r\n  ret i33 0\r\n}\r\n';
  const issues = parseDiagnostics('llvm-as: <stdin>:2:7: error: expected i32\n  ret i33 0\n      ^\n<stdin>:3:1: warning: example\n', text);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].start, text.indexOf('i33'));
  assert.equal(issues[0].end, text.indexOf('i33') + 1);
  assert.equal(issues[0].message, 'expected i32\n  ret i33 0');
  assert.equal(issues[1].severity, 'warning');
  assert.equal(issues[1].start, text.indexOf('}'));
});

test('converts UTF-8 byte columns to UTF-16 without splitting surrogate pairs', () => {
  const text = '; α😀 invalid';
  const col = Buffer.byteLength('; α😀 ') + 1;
  assert.equal(parseDiagnostics(`<stdin>:1:${col}: error: invalid`, text)[0].start, text.indexOf('invalid'));
  const emoji = parseDiagnostics('<stdin>:1:5: error: emoji', text)[0];
  assert.equal(emoji.start, 3);
  assert.equal(emoji.end, 5);
  assert.deepEqual(parseDiagnostics('<stdin>:99:999: error: eof', text)[0], {
    start: text.length, end: text.length, severity: 'error', message: 'eof',
  });
});

test('retains multiline verifier errors without source locations', () => {
  const message = 'llvm-as: assembly parsed, but does not verify as correct!\nInstruction does not dominate all uses!\n  %value = add i32 1, 2\n  ret i32 %value';
  assert.deepEqual(parseDiagnostics(message, 'define'), [{ start: 0, end: 1, message, severity: 'error' }]);
  assert.deepEqual(parseDiagnostics('llvm-as: Unknown command line argument', ''), []);
});

test('missing executable and already cancelled requests are not IR errors', async () => {
  const result = await verifyIR('', { executable: path.join(os.tmpdir(), 'missing-llvm-as-57b87c01') });
  assert.deepEqual(result.issues, []);
  assert.match(result.unavailable, /Cannot run/);
  assert.equal(result.reason, 'missing');
  assert.equal((await probeLLVMAs(path.join(os.tmpdir(), 'missing-llvm-as-57b87c01'))).reason, 'missing');
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await verifyIR('', { signal: controller.signal }), { issues: [], cancelled: true });
});

async function fakeCompiler(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ir-verifier-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fake-llvm-as');
  await fs.writeFile(executable, `#!${process.execPath}\n'use strict';\n${source}\n`, { mode: 0o700 });
  return executable;
}

const fakeOptions = { skip: process.platform === 'win32', timeout: 10000 };

test('passes exact unsaved input and output destination without a shell', fakeOptions, async (t) => {
  const input = '; unsaved α😀\ndefine i32 @f() { ret i32 0 }\n';
  const executable = await fakeCompiler(t, `
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => text += chunk);
    process.stdin.on('end', () => {
      if (text !== ${JSON.stringify(input)} || process.argv[2] !== '-o' || process.argv[3] !== ${JSON.stringify(os.devNull)} || process.argv[4] !== '-') process.exitCode = 2;
    });
  `);
  assert.deepEqual(await verifyIR(input, { executable }), { issues: [] });
});

test('timeouts kill a compiler even when it ignores SIGTERM', fakeOptions, async (t) => {
  const executable = await fakeCompiler(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const result = await verifyIR('', { executable, timeoutMs: 100 });
  assert.match(result.unavailable, /timed out/);
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(result.issues, []);
});

test('cancellation terminates an active compiler', fakeOptions, async (t) => {
  const executable = await fakeCompiler(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timeout));
  assert.deepEqual(await verifyIR('', { executable, signal: controller.signal }), { issues: [], cancelled: true });
});

test('early compiler exit and EPIPE preserve actual LLVM errors', fakeOptions, async (t) => {
  const executable = await fakeCompiler(t, "process.stderr.write('llvm-as: <stdin>:1:1: error: invalid IR\\n', () => process.exit(1));");
  const result = await verifyIR('x'.repeat(8 * 1024 * 1024), { executable });
  assert.equal(result.issues[0].message, 'invalid IR');
  assert.equal(result.unavailable, undefined);
});

test('bounds both stdout and stderr output', fakeOptions, async (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const executable = await fakeCompiler(t, `setInterval(() => process.${stream}.write('x'.repeat(65536)), 1);`);
    const result = await verifyIR('', { executable });
    assert.match(result.unavailable, /output limit/);
    assert.deepEqual(result.issues, []);
  }
});

test('nonzero tool failures cannot silently pass verification', fakeOptions, async (t) => {
  const executable = await fakeCompiler(t, "process.stderr.write('compiler failed to load a library\\n'); process.exitCode = 3;");
  const result = await verifyIR('', { executable });
  assert.deepEqual(result.issues, []);
  assert.match(result.unavailable, /failed to load a library/);
});

test('reads the LLVM version of llvm-as and of the producer of a module', fakeOptions, async (t) => {
  assert.deepEqual(parseLLVMVersion('LLVM (http://llvm.org/):\n  LLVM version 17.0.6\n  Optimized build.'), { major: 17, text: '17.0.6' });
  assert.equal(parseLLVMVersion('llvm-as: unknown'), undefined);
  assert.equal(producerVersion('!llvm.ident = !{!0}\n!0 = !{!"Ubuntu clang version 18.1.3 (1ubuntu1)"}'), 18);
  assert.equal(producerVersion('define void @f() { ret void }'), undefined);
  const executable = await fakeCompiler(t, "if (process.argv[2] === '--version') console.log('LLVM version 16.0.2');");
  assert.deepEqual(await probeLLVMAs(executable), { version: { major: 16, text: '16.0.2' } });
});

const llvmAvailable = spawnSync('llvm-as', ['--version'], { timeout: 2000 }).status === 0;
test('real llvm-as verifies valid, invalid, and verifier-invalid IR', { skip: !llvmAvailable, timeout: 10000 }, async () => {
  assert.deepEqual(await verifyIR('define i32 @main() { ret i32 0 }\n'), { issues: [] });
  const invalid = await verifyIR('define i32 @main() { ret i64 0 }\n');
  assert.ok(invalid.issues.some(issue => issue.severity === 'error'));
  assert.equal(invalid.unavailable, undefined);
  const invalidPhi = await verifyIR('define i32 @main() {\nentry:\n  br label %next\nnext:\n  %x = phi i32 [ 0, %next ]\n  ret i32 %x\n}\n');
  assert.ok(invalidPhi.issues.some(issue => issue.message.includes('PHI')));
  assert.equal(invalidPhi.unavailable, undefined);
});
