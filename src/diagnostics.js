'use strict';

const { spawn } = require('node:child_process');
const { devNull } = require('node:os');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

function sourcePosition(text, lineNumber, byteColumn) {
  const lines = text.split('\n');
  const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  let start = 0;
  for (let i = 0; i < index; i++) start += lines[i].length + 1;
  const line = lines[index].replace(/\r$/, '');
  const target = Math.max(0, byteColumn - 1);
  let bytes = 0;
  let column = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > target) break;
    bytes += width;
    column += character.length;
  }
  start += column;
  const character = line.codePointAt(column);
  return { start, end: start + (character === undefined ? 0 : character > 0xffff ? 2 : 1) };
}

/** Convert llvm-as byte-based locations to UTF-16 document offsets. */
function parseDiagnostics(stderr, text) {
  const issues = [];
  const preamble = [];
  let current;
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/^.*?:(\d+):(\d+):\s*(error|warning):\s*(.*)$/);
    if (match) {
      current = {
        ...sourcePosition(text, Number(match[1]), Number(match[2])),
        message: match[4],
        severity: match[3],
      };
      issues.push(current);
    } else if (current) {
      // Retain source excerpts and verifier explanations, but not caret-only lines.
      if (!/^\s*\^~*\s*$/.test(line)) current.message += '\n' + line;
    } else {
      preamble.push(line);
    }
  }
  const unpositioned = preamble.join('\n').trim();
  if (unpositioned && /does not verify as correct|verification failed|broken module|(?:^|\n)(?:[^\n]*?:\s*)?(?:error|warning):/i.test(unpositioned)) {
    issues.unshift({
      ...sourcePosition(text, 1, 1),
      message: unpositioned,
      severity: /(?:^|\n)(?:[^\n]*?:\s*)?warning:/i.test(unpositioned) ? 'warning' : 'error',
    });
  }
  for (const issue of issues) issue.message = issue.message.trimEnd();
  return issues;
}

// `missing`: no such executable; `not-executable`: found but cannot be run.
function spawnReason(error) {
  if (error && error.code === 'ENOENT') return 'missing';
  if (error && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOEXEC')) return 'not-executable';
  return 'failed';
}

/** Major LLVM version from `llvm-as --version` output, e.g. 18 for "LLVM version 18.1.3". */
function parseLLVMVersion(output) {
  const match = /LLVM version (\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(output || '');
  return match ? { major: Number(match[1]), text: match.slice(1).filter(part => part !== undefined).join('.') } : undefined;
}

/** Major LLVM version that produced a module, from its `clang version` ident. */
function producerVersion(text) {
  const match = /!\{\s*!"[^"]*?(?:clang|LLVM|flang|rustc)[^"]*?version (\d+)\.\d+/i.exec(text || '');
  return match ? Number(match[1]) : undefined;
}

/** Run `llvm-as --version`: `{ version }`, or `{ unavailable, reason }`. */
function probeLLVMAs(executable = 'llvm-as', { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child, done = false, output = '';
    const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      finish({ unavailable: `${executable} --version timed out after ${timeoutMs} ms.`, reason: 'timeout' });
    }, timeoutMs);
    try {
      child = spawn(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ unavailable: `Cannot start ${executable}: ${error.message}`, reason: spawnReason(error) });
      return;
    }
    const receive = (chunk) => { if (output.length < 64 * 1024) output += chunk.toString('utf8'); };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', (error) => finish({ unavailable: `Cannot run ${executable}: ${error.message}`, reason: spawnReason(error) }));
    child.on('close', (code) => {
      const version = parseLLVMVersion(output);
      if (version) finish({ version });
      else finish({ unavailable: `${executable} --version did not report an LLVM version${code ? ` (exit code ${code})` : ''}.`, reason: 'failed' });
    });
  });
}

/** Verify the provided (possibly unsaved) IR without executing it or writing user files. */
function verifyIR(text, options = {}) {
  const executable = options.executable || 'llvm-as';
  const signal = options.signal;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (signal && signal.aborted) return Promise.resolve({ issues: [], cancelled: true });

  return new Promise((resolve) => {
    let child;
    let timer;
    let done = false;
    let stopped;
    let inputError;
    let outputBytes = 0;
    const stderr = [];
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = (result) => {
      if (done || stopped) return;
      stopped = result;
      // SIGKILL also bounds compilers that ignore graceful termination.
      child.kill('SIGKILL');
      child.stdin.destroy();
    };
    const abort = () => stop({ issues: [], cancelled: true });
    try {
      child = spawn(executable, ['-o', devNull, '-'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ issues: [], unavailable: `Cannot start ${executable}: ${error.message}`, reason: spawnReason(error) });
      return;
    }
    child.on('error', (error) => {
      finish(stopped || { issues: [], unavailable: `Cannot run ${executable}: ${error.message}`, reason: spawnReason(error) });
    });
    child.stdin.on('error', (error) => {
      // llvm-as can reject input before stdin finishes, which legitimately causes EPIPE.
      inputError = error;
    });
    const receive = (chunk, isStderr) => {
      if (done || stopped) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop({ issues: [], unavailable: `${executable} exceeded the 1 MiB output limit.`, reason: 'output-limit' });
      } else if (isStderr) {
        stderr.push(chunk);
      }
    };
    child.stdout.on('data', (chunk) => receive(chunk, false));
    child.stderr.on('data', (chunk) => receive(chunk, true));
    child.on('close', (code, exitSignal) => {
      if (stopped) return finish(stopped);
      const output = Buffer.concat(stderr).toString('utf8').trim();
      const issues = parseDiagnostics(output, text);
      if (exitSignal) {
        finish({ issues: [], unavailable: `${executable} terminated with ${exitSignal}.`, reason: 'crashed' });
      } else if (issues.length) {
        finish({ issues });
      } else if (code !== 0 || inputError) {
        const detail = output || (inputError && inputError.message) || `exit code ${code}`;
        finish({ issues: [], unavailable: `${executable} could not verify the IR: ${detail}`, reason: 'failed' });
      } else {
        finish({ issues: [] });
      }
    });
    timer = setTimeout(() => stop({
      issues: [], unavailable: `${executable} verification timed out after ${timeoutMs} ms.`, reason: 'timeout',
    }), timeoutMs);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    if (!stopped) {
      try {
        child.stdin.end(text, 'utf8');
      } catch (error) {
        stop({ issues: [], unavailable: `Cannot send IR to ${executable}: ${error.message}`, reason: 'failed' });
      }
    }
  });
}

module.exports = { parseDiagnostics, verifyIR, probeLLVMAs, parseLLVMVersion, producerVersion };
