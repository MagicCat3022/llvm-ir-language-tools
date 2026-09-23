'use strict';

// Per-keystroke cost of every editor feature, outside VS Code.
//
//   node scripts/bench.js file.ll [more.ll ...] [--runs N]
//
// Each run edits the document (so no cached analysis applies), then asks each
// provider for what VS Code requests after typing: the whole document for
// semantic tokens, folding, symbols, CodeLens and label colors, and a visible
// screen of about 60 lines for inlay hints. Hover, completion and code actions
// run at a cursor in the middle of the file. Times are medians in milliseconds.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  compareTo(other) { return this.line - other.line || this.character - other.character; }
  isBefore(other) { return this.compareTo(other) < 0; }
}
class Range {
  constructor(start, end, endLine, endCharacter) {
    if (typeof start === 'number') { start = new Position(start, end); end = new Position(endLine, endCharacter); }
    this.start = start; this.end = end;
  }
  contains(value) { return value instanceof Range ? this.contains(value.start) && this.contains(value.end) : this.start.compareTo(value) <= 0 && this.end.compareTo(value) >= 0; }
}
class MarkdownString {
  constructor() { this.value = ''; }
  appendText(value) { this.value += value; return this; }
  appendMarkdown(value) { this.value += value; return this; }
  appendCodeblock(value) { this.value += value; return this; }
}
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
const plain = name => class { constructor(...args) { this.kind = name; this.args = args; } };
const enumValues = new Proxy({}, { get: (_, key) => key });
const settings = {};
const vscode = new Proxy({
  Position, Range, MarkdownString, EventEmitter,
  Uri: { parse: value => ({ toString: () => value }) },
  SemanticTokensBuilder: class { constructor() { this.count = 0; } push() { this.count++; } build() { return { count: this.count }; } },
  workspace: { isTrusted: true, textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
  window: { visibleTextEditors: [], createTextEditorDecorationType: () => ({ dispose() {} }) },
  languages: {},
}, { get: (target, key) => key in target ? target[key] : /Kind|Severity|Tag|Location$/.test(key) && !/^(Location)$/.test(key) ? enumValues : plain(key) });

const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args); };
const extension = require('../src/extension');
const { checkIR } = require('../src/checks');
Module._load = originalLoad;

function documentFor(uri) {
  let starts = [0];
  const document = {
    uri: { toString: () => uri }, languageId: 'llvm-ir', version: 0, isClosed: false, text: '',
    getText() { return this.text; },
    setText(text) {
      this.text = text; this.version++;
      starts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      this.lineCount = starts.length;
    },
    positionAt(offset) {
      offset = Math.max(0, Math.min(offset, this.text.length));
      let low = 0, high = starts.length - 1;
      while (low < high) { const middle = (low + high + 1) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle - 1; }
      return new Position(low, offset - starts[low]);
    },
    offsetAt(position) { return Math.min(this.text.length, (starts[position.line] ?? this.text.length) + position.character); },
  };
  return document;
}

function time(callback) { const start = performance.now(); const result = callback(); return [performance.now() - start, result]; }
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1]; };

function bench(file, runs) {
  const original = fs.readFileSync(file, 'utf8');
  const document = documentFor(`file://${path.resolve(file)}`);
  const providers = extension.createProviders(new Map());
  const editor = { document, setDecorations() {} };
  const labels = extension.createLabelDecorations(providers.analyze);
  // The cursor sits at a mid-file instruction operand, where people type.
  const middle = original.indexOf('\n  %', original.length >> 1) + 4;
  const stages = {};
  const record = (name, ms) => (stages[name] ||= []).push(ms);
  for (let run = 0; run < runs; run++) {
    // An edit at the cursor that keeps the IR valid: a trailing comment.
    document.setText(original.slice(0, middle) + original.slice(middle).replace('\n', ` ; edit ${run}\n`));
    const cursor = document.positionAt(middle);
    const visible = new Range(new Position(Math.max(0, cursor.line - 30), 0), new Position(cursor.line + 30, 0));
    record('analyze', time(() => providers.analyze(document))[0]);
    record('built-in checks', time(() => checkIR(providers.analyze(document)))[0]);
    record('semantic tokens', time(() => providers.semantic.provideDocumentSemanticTokens(document))[0]);
    record('label colors', time(() => labels.paint(editor))[0]);
    record('folding', time(() => providers.folding.provideFoldingRanges(document))[0]);
    record('document symbols', time(() => providers.symbols.provideDocumentSymbols(document))[0]);
    record('CodeLens', time(() => providers.lenses.provideCodeLenses(document))[0]);
    record('inlay hints (screen)', time(() => providers.inlays.provideInlayHints(document, visible))[0]);
    record('code actions (cursor)', time(() => providers.codeActions.provideCodeActions(document, new Range(cursor, cursor), { diagnostics: [] }))[0]);
    record('hover (cursor)', time(() => providers.hover.provideHover(document, cursor))[0]);
    record('completion (cursor)', time(() => providers.completion.provideCompletionItems(document, cursor))[0]);
  }
  labels.dispose(); providers.dispose();
  const result = Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, median(values)]));
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return { bytes: Buffer.byteLength(original), lines: original.split('\n').length, result };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const runs = runsAt >= 0 ? Number(args.splice(runsAt, 2)[1]) : 5;
  if (!args.length) { console.error('usage: node scripts/bench.js file.ll [more.ll ...] [--runs N]'); process.exit(2); }
  const results = args.map(file => ({ file: path.basename(file), ...bench(file, runs) }));
  const names = Object.keys(results[0].result);
  const width = Math.max(...names.map(name => name.length));
  console.log(''.padEnd(width), ...results.map(item => item.file.padStart(14)));
  console.log('size'.padEnd(width), ...results.map(item => `${(item.bytes / 1024).toFixed(0)} KiB`.padStart(14)));
  for (const name of names) console.log(name.padEnd(width), ...results.map(item => item.result[name].toFixed(1).padStart(14)));
}

module.exports = { bench };
