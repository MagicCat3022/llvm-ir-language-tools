'use strict';

// Some tests exercise real coursework IR. It lives beside this project in the
// course checkout and is never published with it; set LLVM_IR_COURSE_DIR to
// point elsewhere. Without the files, those tests are skipped with a reason.
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.LLVM_IR_COURSE_DIR || path.resolve(__dirname, '../../..');

function courseFile(relative) {
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return undefined; }
}

// A node:test `skip` value: false when every file exists, else the reason.
function courseSkip(...relatives) {
  const missing = relatives.filter(relative => courseFile(relative) === undefined);
  return missing.length ? `course files not present: ${missing.join(', ')} (set LLVM_IR_COURSE_DIR)` : false;
}

module.exports = { courseFile, courseSkip, courseRoot: root };
