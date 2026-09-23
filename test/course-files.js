'use strict';

// Some tests exercise real coursework IR, which is never published with this
// project. LLVM_IR_COURSE_DIR names the directory containing hw0/ and hw2/,
// from the environment or a gitignored .env file at the project root (see
// .env.example). Without the files, those tests are skipped with a reason.
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');

// Reads one KEY=value from .env; Node 18 has no built-in .env loading.
function fromEnvFile(key) {
  let text;
  try { text = fs.readFileSync(path.join(project, '.env'), 'utf8'); } catch { return undefined; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] === key) return match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

function courseRoot() {
  const configured = process.env.LLVM_IR_COURSE_DIR || fromEnvFile('LLVM_IR_COURSE_DIR');
  if (!configured) return path.resolve(project, '../..');
  const home = configured.replace(/^~(?=$|[\\/])/, require('node:os').homedir());
  return path.resolve(project, home);
}
const root = courseRoot();

function courseFile(relative) {
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return undefined; }
}

// A node:test `skip` value: false when every file exists, else the reason.
function courseSkip(...relatives) {
  const missing = relatives.filter(relative => courseFile(relative) === undefined);
  return missing.length ? `course files not present: ${missing.join(', ')} (set LLVM_IR_COURSE_DIR)` : false;
}

module.exports = { courseFile, courseSkip, courseRoot: root };
