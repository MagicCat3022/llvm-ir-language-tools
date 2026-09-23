'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { courseFile, courseSkip } = require('./course-files');

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
  compareTo(other) { return this.line - other.line || this.character - other.character; }
}
class Range {
  constructor(start, end) { Object.assign(this, { start, end }); }
  contains(value) { return value instanceof Range ? this.contains(value.start) && this.contains(value.end) : this.start.compareTo(value) <= 0 && this.end.compareTo(value) >= 0; }
}
class MarkdownString {
  constructor() { this.value = ''; }
  appendText(value) { this.value += value; return this; }
  appendMarkdown(value) { this.value += value; return this; }
  appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\`\n`; return this; }
}
class EventEmitter {
  constructor() { this.listeners = []; this.event = callback => { this.listeners.push(callback); return { dispose() {} }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners = []; }
}
const enumValues = new Proxy({}, { get: (_, key) => key });
let settings = {}, notifications = [];
const registrations = new Map(), workspaceEvents = new Map();
const collection = () => ({ values: new Map(), set(uri, issues) { this.values.set(uri.toString(), issues); }, delete(uri) { this.values.delete(uri.toString()); }, clear() { this.values.clear(); }, dispose() { this.clear(); } });
const mock = {
  Position, Range, MarkdownString, EventEmitter,
  Uri: { parse: value => ({ toString: () => value, path: value }) },
  SymbolInformation: class { constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); } },
  Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
  CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
  SignatureInformation: class { constructor(label, documentation) { Object.assign(this, { label, documentation }); } },
  ParameterInformation: class { constructor(label) { this.label = label; } },
  SignatureHelp: class {},
  Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, newText) { this.edits.push({ uri, range, newText }); } insert(uri, position, newText) { this.edits.push({ uri, range: new Range(position, position), newText }); } },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }); } },
  DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } },
  DocumentHighlight: class { constructor(range, kind) { Object.assign(this, { range, kind }); } },
  SemanticTokensBuilder: class { constructor() { this.rows = []; } push(...row) { this.rows.push(row); } build() { return { rows: this.rows }; } },
  SemanticTokensLegend: class { constructor(tokenTypes, tokenModifiers) { Object.assign(this, { tokenTypes, tokenModifiers }); } },
  FoldingRange: class { constructor(start, end, kind) { Object.assign(this, { start, end, kind }); } },
  InlayHint: class { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } },
  InlayHintLabelPart: class { constructor(value) { this.value = value; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Selection: class extends Range { constructor(anchor, active) { super(anchor, active); Object.assign(this, { anchor, active }); } },
  ViewColumn: { One: 1, Beside: -2 }, TextEditorRevealType: enumValues,
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  TextEdit: { replace: (range, newText) => ({ range, newText }), insert: (position, newText) => ({ range: new Range(position, position), newText }) },
  CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
  CompletionItemKind: enumValues, CodeActionKind: enumValues, DiagnosticTag: enumValues, ProgressLocation: enumValues, SymbolKind: enumValues, DocumentHighlightKind: enumValues, FoldingRangeKind: enumValues, InlayHintKind: enumValues, DiagnosticSeverity: enumValues,
  workspace: { isTrusted: true, textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
  window: { visibleTextEditors: [], activeTextEditor: undefined,
    createTextEditorDecorationType: options => ({ options, dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }), onDidChangeTextEditorSelection: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    withProgress: (options, task) => task({ report() {} }, { isCancellationRequested: false }), showWarningMessage: message => { notifications.push(message); return new Promise(() => {}); }, showInformationMessage: message => { notifications.push(message); return new Promise(() => {}); }, createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { registerCommand: (name, callback) => { registrations.set(name, callback); return { dispose() { registrations.delete(name); } }; } },
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  languages: { createDiagnosticCollection: collection, createLanguageStatusItem: (id, selector) => ({ id, selector, dispose() {} }) }
};
for (const name of ['Hover', 'CompletionItem', 'SignatureHelp', 'Definition', 'Reference', 'Rename', 'DocumentSymbol', 'DocumentHighlight', 'DocumentFormattingEdit', 'DocumentSemanticTokens', 'FoldingRange', 'InlayHints', 'CodeLens', 'CodeActions']) {
  mock.languages[`register${name}Provider`] = (selector, provider, ...args) => { registrations.set(name, { selector, provider, args }); return { dispose() { registrations.delete(name); } }; };
}
mock.languages.registerWorkspaceSymbolProvider = provider => { registrations.set('WorkspaceSymbol', { provider }); return { dispose() { registrations.delete('WorkspaceSymbol'); } }; };
for (const name of ['OpenTextDocument', 'ChangeTextDocument', 'SaveTextDocument', 'CloseTextDocument', 'GrantWorkspaceTrust', 'ChangeConfiguration']) {
  mock.workspace[`onDid${name}`] = callback => { workspaceEvents.set(name, callback); return { dispose() { workspaceEvents.delete(name); } }; };
}
const originalLoad = Module._load;
let extension;
try {
  Module._load = function (request, ...args) { return request === 'vscode' ? mock : originalLoad.call(this, request, ...args); };
  extension = require('../src/extension');
} finally { Module._load = originalLoad; }

let nextDocument = 0;
function document(text, name = `test-${nextDocument++}`) {
  return {
    text, version: 1, languageId: 'llvm-ir', isClosed: false, uri: { toString: () => `untitled:${name}` },
    getText(range) { return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text; },
    positionAt(offset) {
      offset = Math.max(0, Math.min(offset, this.text.length));
      const before = this.text.slice(0, offset).split('\n');
      return new Position(before.length - 1, before.at(-1).length);
    },
    offsetAt(position) {
      const lines = this.text.split('\n');
      return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
    },
    at(needle, delta = 0, from = 0) { const index = this.text.indexOf(needle, from); assert.notEqual(index, -1, needle); return this.positionAt(index + delta); }
  };
}
const ir = `%Node = type { i32 }
declare i32 @printf(ptr noundef %fmt, ...)
define i32 @first(i32 %value, ptr %p) {
entry:
  %Node = add i32 %value, 1
  %result = call i32 (ptr, ...) @printf(ptr %p, i32 %Node, i32 9)
  br label %"exit block"
"exit block":
  ret i32 %Node
}
define i32 @second(i32 %value) {
entry:
  %result = add i32 %value, 2
  ret i32 %result
}
@text = private constant [11 x i8] c"add %value"
; add %value @first
`;
test.beforeEach(() => { settings = {}; notifications = []; mock.workspace.isTrusted = true; mock.workspace.textDocuments = []; });

test('hover provides inferred types, honest pointers, function signatures and safe documentation', () => {
  const providers = extension.createProviders(), doc = document(ir);
  const local = providers.hover.provideHover(doc, doc.at('%Node = add', 2));
  assert.match(local.contents.value, /\(variable\) %Node: i32 = add i32 %value, 1/);
  assert.equal(local.contents.isTrusted, false);
  assert.match(providers.hover.provideHover(doc, doc.at('ptr %p', 5)).contents.value, /\(parameter\) %p: ptr/);
  const fn = providers.hover.provideHover(doc, doc.at('@printf', 3));
  assert.match(fn.contents.value, /i32 @printf\(ptr noundef %fmt, \.\.\.\)/);
  assert.match(fn.contents.value, /noundef/);
  const keyword = providers.hover.provideHover(doc, doc.at('add i32', 1));
  assert.match(keyword.contents.value, /LLVM Language Reference/);
  assert.match(keyword.contents.value, /https:\/\/llvm.org\/docs\/LangRef.html/);
  assert.match(keyword.contents.value, /^\s*```llvm-ir\n\(instruction\) <result> = add <type> <op1>, <op2>\n```\n\n\n---\n\nAdds integers/);
  const forms = document('define void @f() {\nentry:\n  ret void\n}\n@g = global i32 add nsw (i32 1, i32 2)');
  assert.match(providers.hover.provideHover(forms, forms.at('ret void', 1)).contents.value, /\(instruction\) ret <type> <value>\n\(instruction\) ret void\n/);
  assert.match(providers.hover.provideHover(forms, forms.at('nsw', 1)).contents.value, /```llvm-ir\n\(keyword\) nsw\n```/);
  assert.match(providers.hover.provideHover(forms, forms.at('i32 1', 1)).contents.value, /```llvm-ir\n\(type\) i32\n```/);
  assert.equal(providers.hover.provideHover(doc, doc.at('; add', 3)), undefined);
  assert.equal(providers.hover.provideHover(doc, doc.at('c"add', 3)), undefined);
  providers.dispose();
});

test('function hover shows one Pylance-style signature without a repeated declaration', () => {
  const providers = extension.createProviders();
  const doc = document('define i32 @fib(i32 %a) {\nentry:\n ret i32 %a\n}\n');
  const hover = providers.hover.provideHover(doc, doc.at('@fib', 2));
  assert.equal(hover.contents.value.trim(), '```llvm-ir\n(function) i32 @fib(i32 %a)\n```');
  assert.equal(hover.contents.isTrusted, false);
  const attributed = document('declare fastcc zeroext i32 @external(ptr noundef %p, ...) nounwind\n');
  const detail = providers.hover.provideHover(attributed, attributed.at('@external', 2));
  assert.equal(detail.contents.value.trim(), '```llvm-ir\n(function) fastcc zeroext i32 @external(ptr noundef %p, ...) nounwind\n```');
  providers.dispose();
});

test('completion replaces a full sigil prefix once and limits locals to the containing function', () => {
  const providers = extension.createProviders(), doc = document(ir);
  const position = doc.at('i32 %Node,', 7);
  const items = providers.completion.provideCompletionItems(doc, position);
  const item = items.find(item => item.label === '%Node' && item.detail.startsWith('i32'));
  assert.ok(item);
  assert.equal(doc.getText(item.range), '%Node');
  assert.equal(item.insertText, '%Node');
  assert.equal(items.some(item => item.label === '@printf'), false);
  const second = providers.completion.provideCompletionItems(doc, doc.at('ret i32 %result', 15));
  assert.equal(second.some(item => item.label === '%p'), false);
  const partial = document('define void @main() {\n  call void @\n}');
  const global = providers.completion.provideCompletionItems(partial, partial.at('void @\n', 6)).find(item => item.label === '@main');
  assert.equal(partial.getText(global.range), '@');
  assert.equal(global.insertText, '@main');
  assert.deepEqual(providers.completion.provideCompletionItems(doc, doc.at('; add', 5)), []);
  assert.deepEqual(providers.completion.provideCompletionItems(doc, doc.at('c"add', 5)), []);
  providers.dispose();
});

test('signature help clamps additional variadic arguments', () => {
  const providers = extension.createProviders(), doc = document(ir);
  const help = providers.signatures.provideSignatureHelp(doc, doc.at('i32 9)', 5));
  assert.equal(help.activeParameter, 1);
  assert.equal(help.signatures[0].parameters[1].label, '...');
  assert.match(help.signatures[0].label, /@printf\(ptr %fmt, \.\.\.\)/);
  assert.equal(help.signatures[0].documentation.value, 'Line 2');
  assert.ok(!help.signatures[0].documentation.value.includes('@printf'));
  providers.dispose();
});

test('label hover gives the definition line and owning function, including after edits', () => {
  const providers = extension.createProviders();
  for (const name of ['base', '"base block"', '2']) {
    const doc = document([
      'define void @fib() {', 'entry:', ' br label %' + name,
      name + ':', ' ret void', '}', 'define void @other() {',
      name + ':', ' ret void', '}'
    ].join('\r\n'));
    const expected = '```llvm-ir\n(label) %' + name + '\n```\n\n\n---\n\nPredecessors: `%entry`\n\nLeaves the function with `ret`.\n\n' +
      'Immediate dominator: `%entry`, which every path here passes through.';
    assert.equal(providers.hover.provideHover(doc, doc.at(name + ':')).contents.value.trim(), expected + '\n\nLine 4 in @fib');
    // A branch target also previews the block it jumps to.
    const hover = providers.hover.provideHover(doc, doc.at('label %' + name, 7)).contents.value.trim();
    assert.ok(hover.startsWith(expected), hover);
    assert.match(hover, new RegExp('```llvm-ir\\n' + name.replace(/"/g, '"') + ':\\n ret void\\n```\\s+Line 4 in @fib$'));
    doc.text = '; inserted line\r\n' + doc.text;
    doc.version++;
    assert.match(providers.hover.provideHover(doc, doc.at('label %' + name, 7)).contents.value, /Line 5 in @fib/);
  }
  providers.dispose();
});

test('symbol hovers have one useful preview and no inapplicable type or kind filler', () => {
  const providers = extension.createProviders();
  const doc = document([
    '%Pair = type { i32, i32 }',
    '@count = global i32 7',
    '!0 = !{i32 42}',
    'attributes #0 = { nounwind }',
    'define i1 @check(i32 %a) {',
    'entry:',
    ' %ok = icmp eq i32 %a, 0',
    ' %future = future_opcode i32 %a',
    ' ret i1 %ok',
    '}'
  ].join('\n'));
  const get = needle => providers.hover.provideHover(doc, doc.at(needle, 1)).contents.value.trim();
  assert.equal(get('%a)'), '```llvm-ir\n(parameter) %a: i32\n```\n\n\n---\n\nLine 5 in @check');
  assert.equal(get('%ok ='), '```llvm-ir\n(variable) %ok: i1 = icmp eq i32 %a, 0\n```\n\n\n---\n\nLine 7 in @check');
  assert.match(get('%future ='), /\(variable\) %future: Unknown = future_opcode i32 %a/);
  for (const [needle, header, line] of [
    ['%Pair', '(type) %Pair = type { i32, i32 }', 1], ['@count', '(global) @count: i32 = global i32 7', 2],
    ['!0', '(metadata) !0 = !{i32 42}', 3], ['#0', '(attributes) #0 = { nounwind }', 4]
  ]) {
    const value = get(needle);
    assert.equal((value.match(/```llvm-ir/g) || []).length, 1, needle);
    assert.equal(value, '```llvm-ir\n' + header + '\n```\n\n\n---\n\nLine ' + line);
    assert.ok(!value.includes('unknown'), value);
    assert.equal(value.split(needle).length - 1, 1, 'name is not repeated');
  }
  const outline = providers.symbols.provideDocumentSymbols(doc);
  assert.equal(outline.find(item => item.name === '!0').detail, '');
  assert.equal(outline.find(item => item.name === '#0').detail, '');
  assert.equal(outline.find(item => item.name === '@check').children.find(item => item.name === '%entry').detail, '');
  providers.dispose();
});

test('opaque pointer hover shows explicit stack storage and a qualified access hint', { skip: courseSkip('hw2/objects.llvm') }, () => {
  const providers = extension.createProviders();
  const text = courseFile('hw2/objects.llvm');
  const doc = document(text);
  const slot = providers.hover.provideHover(doc, doc.at('%main_ptr =', 2)).contents.value;
  assert.match(slot, /Line 91 in @main/);
  assert.match(slot, /\(variable\) %main_ptr: ptr → ptr → %Class_Main\? = alloca ptr, align 8/);
  assert.match(slot, /`%Class_Main\?` — `@Main` indexes the stored pointer as this type/);
  const object = providers.hover.provideHover(doc, doc.at('%main_obj =', 2)).contents.value;
  assert.match(object, /%main_obj: ptr → %Class_Main\? =/);
  assert.match(object, /`%Class_Main\?` — `@Main` indexes it as this type/);
  providers.dispose();
});

test('pointer hovers follow GEP fields, stack slots, object fields, and constant tables', { skip: courseSkip('hw2/objects.llvm') }, () => {
  const providers = extension.createProviders();
  const text = courseFile('hw2/objects.llvm');
  const doc = document(text);
  const hover = (needle, from = 0) => providers.hover.provideHover(doc, doc.at(needle, 2, doc.text.indexOf(from || needle))).contents.value;
  // The header carries the pointee exactly as the inlay hint does; one line explains it.
  assert.equal(hover('%t1 =').trim(), '```llvm-ir\n(variable) %t1: ptr → i32 = getelementptr %Class_Dog, ptr %this, i32 0, i32 1\n```\n\n\n---\n\n`i32` — field 1 of `%Class_Dog`\n\nLine 46 in @Dog');
  assert.match(hover('%vptr =', 'define void @Dog'), /%vptr: ptr → ptr =[^]*`ptr` — field 0 of `%Class_Dog`/);
  assert.match(hover('%a_obj ='), /%a_obj: ptr → %Class_Dog\? =[^]*`%Class_Dog\?` — `@Dog` indexes it as this type/);
  assert.match(hover('%a_vtbl ='), /%a_vtbl: ptr → @dogVTBL\? =[^]*`@dogVTBL\?` — the only address stored to field 0 of `%Class_Dog` \(in `@Dog`\)/);
  assert.match(hover('%a.makeNoise_ptr ='), /%a.makeNoise_ptr: ptr → @dogVTBL\[0\]\? =[^]*`@dogVTBL\[0\]\?` — `%a_vtbl` likely points to `@dogVTBL`/);
  assert.match(hover('%a.makeNoise_method ='), /%a.makeNoise_method: ptr → @dog_makeNoise\? =[^]*`@dog_makeNoise\?` — the address in element 0 of `@dogVTBL`/);
  // The indirect call site hovers the same SSA value.
  assert.match(hover('%a.makeNoise_method(', 'call void %a.makeNoise_method'), /ptr → @dog_makeNoise\?/);
  // Methods that never index %this still get a receiver from the vtables listing them.
  assert.match(hover('%this', 'define void @dog_bark'), /\(parameter\) %this: ptr → %Class_Dog\?\n[^]*`%Class_Dog\?` — listed in `@dogVTBL`/);
  assert.match(hover('%this', 'define void @animal_attack'), /%this: ptr → %Class_Animal \| %Class_Dog\?\n[^]*— listed in `@animalVTBL`, `@dogVTBL`/);
  assert.doesNotMatch(hover('%this', 'define void @dog_makeNoise'), /listed in/, 'a direct access type takes precedence');
  providers.dispose();
});

test('inlay hints append the inferred pointee and explain it in a tooltip', { skip: courseSkip('hw2/objects.llvm') }, () => {
  const providers = extension.createProviders();
  const text = courseFile('hw2/objects.llvm');
  const doc = document(text);
  const lines = text.split('\n');
  const hints = providers.inlays.provideInlayHints(doc, new Range(new Position(0, 0), new Position(lines.length, 0)));
  const at = (line, name) => hints.find(hint => hint.position.line === line - 1 && lines[line - 1].slice(0, hint.position.character).endsWith(name));
  assert.equal(at(46, '%t1').label, ': ptr → i32');
  assert.equal(at(55, '%id').label, ': i32', 'non-pointers are unchanged');
  assert.equal(at(71, '%a_ptr').label, ': ptr → ptr → %Class_Dog?');
  assert.equal(at(76, '%a_obj').label, ': ptr → %Class_Dog?');
  assert.equal(at(77, '%a_vtbl').label, ': ptr → @dogVTBL?');
  assert.equal(at(78, '%a.makeNoise_ptr').label, ': ptr → @dogVTBL[0]?');
  assert.equal(at(79, '%a.makeNoise_method').label, ': ptr → @dog_makeNoise?');
  assert.match(at(79, '%a.makeNoise_method').tooltip.value, /`@dog_makeNoise\?` — the address in element 0 of `@dogVTBL`/);
  assert.equal(at(22, '%this').label, ': ptr → %Class_Animal?');
  assert.equal(at(36, '%this').label, ': ptr → %Class_Animal | %Class_Dog?');
  assert.match(at(36, '%this').tooltip.value, /listed in `@animalVTBL`, `@dogVTBL`/);
  assert.equal(at(41, '%id'), undefined, 'parameters without a pointee get no hint');
  assert.equal(at(24, '%vptr').tooltip.value, '`ptr` — field 0 of `%Class_Animal`');
  providers.dispose();
});

test('pointer value hints are withheld when stores conflict or a table is mutable', () => {
  const providers = extension.createProviders();
  const doc = document([
    '%S = type { ptr, i32 }',
    '@t = constant [2 x ptr] [ptr @a, ptr @b]',
    '@m = global [2 x ptr] [ptr @a, ptr @b]',
    'declare void @a()',
    'declare void @b()',
    'define void @init(ptr %s, ptr %other) {',
    '  %f = getelementptr %S, ptr %s, i32 0, i32 0',
    '  store ptr @t, ptr %f',
    '  %g = getelementptr %S, ptr %other, i32 0, i32 0',
    '  store ptr %other, ptr %g',
    '  ret void',
    '}',
    'define void @use(ptr %s) {',
    '  %f2 = getelementptr %S, ptr %s, i32 0, i32 0',
    '  %v = load ptr, ptr %f2',
    '  %direct = getelementptr [2 x ptr], ptr @t, i32 0, i32 1',
    '  %d = load ptr, ptr %direct',
    '  %mutable = getelementptr ptr, ptr @m, i64 1',
    '  %md = load ptr, ptr %mutable',
    '  ret void',
    '}'
  ].join('\n'));
  const hover = needle => providers.hover.provideHover(doc, doc.at(needle, 1)).contents.value;
  assert.match(hover('%v ='), /%v: ptr = load[^]*\n---\n\nLine 15 in @use$/, 'no pointee or note for a conflicting field');
  assert.match(hover('%direct ='), /%direct: ptr → @t\[1\] =/);
  assert.match(hover('%d ='), /%d: ptr → @b =[^]*`@b` — the address in element 1 of `@t`/);
  assert.match(hover('%md ='), /%md: ptr = load[^]*\n---\n\nLine 19 in @use$/, 'no pointee or note for a mutable table');
  const labels = providers.inlays.provideInlayHints(doc, new Range(new Position(0, 0), new Position(30, 0))).map(hint => hint.label);
  assert.ok(labels.includes(': ptr → @t[1]') && labels.includes(': ptr → @b'), 'facts stated by the IR carry no ?');
  assert.ok(labels.includes(': ptr → ptr'), 'an ambiguous field load shows only its address type');
  providers.dispose();
});

test('completion offers branch targets, predicates, and dominating values of the expected type', () => {
  const providers = extension.createProviders();
  const text = `declare i32 @g(i32 %n, ptr %s)
@flag = global i1 false
define i32 @f(i32 %a, ptr %p) {
entry:
  %x = add i32 %a, 1
  %c = icmp slt i32 %x, 10
  br i1 %c, label %then, label %else
then:
  %y = mul i32 %x, 2
  br label %join
else:
  %z = sub i32 %x, 1
  br label %join
join:
  %m = phi i32 [ %y, %then ], [ %z, %else ]
  %r = call i32 @g(i32 %m, ptr %p)
  ret i32 %m
}`;
  const labels = (edited, marker) => {
    const doc = document(edited), items = providers.completion.provideCompletionItems(doc, doc.at(marker, marker.length));
    return items.map(item => item.label);
  };
  assert.deepEqual(labels(text.replace('label %then,', 'label %,'), 'label %'), ['%then', '%else', '%join'], 'the entry block is never a target');
  assert.deepEqual(labels(text.replace('%y, %then', '%y, %'), '%y, %'), ['%then', '%else', '%join']);
  const predicates = labels(text.replace('icmp slt', 'icmp '), 'icmp ');
  assert.deepEqual(predicates.slice(0, 3), ['eq', 'ne', 'ugt']);
  assert.equal(predicates.includes('%x'), false);
  assert.ok(labels(text.replace('fcmp', 'fcmp').replace('%c = icmp slt', '%c = fcmp fast '), 'fcmp fast ').includes('oeq'));
  // `ret i32` in %join: %y and %z do not dominate it, %p is not an i32.
  const values = labels(text.replace('ret i32 %m', 'ret i32 %'), 'ret i32 %');
  assert.deepEqual(values, ['%a', '%x', '%m', '%r']);
  const doc = document(text.replace('ret i32 %m', 'ret i32 '));
  const constants = providers.completion.provideCompletionItems(doc, doc.at('ret i32 ', 8));
  assert.ok(constants.some(item => item.label === 'poison'));
  assert.equal(constants.some(item => item.label === 'null' || item.label === 'add'), false);
  assert.deepEqual(labels(text.replace('%y = mul i32 %x, 2', '%y = mul i32 %x, %'), 'mul i32 %x, %'), ['%a', '%x']);
  assert.ok(labels(text.replace('store', 'store').replace('ret i32 %m', 'store i1 true, ptr @\n  ret i32 %m'), 'ptr @').includes('@flag'));
  const call = document(text.replace('@g(i32 %m, ptr %p)', '@g(i32 %m, '));
  const typed = providers.completion.provideCompletionItems(call, call.at('%m, ', 4)).find(item => item.label === '%p');
  assert.equal(typed.insertText, 'ptr %p');
  assert.equal(typed.filterText, '%p');
  const callee = labels(text.replace('call i32 @g(i32 %m, ptr %p)', 'call i32 @'), 'call i32 @');
  assert.deepEqual(callee, ['@g', '@f']);
  providers.dispose();
});

test('inlay hints name call arguments from parameters or library documentation', () => {
  const providers = extension.createProviders();
  const doc = document('declare i32 @printf(ptr, ...)\ndefine i32 @add(i32 %lhs, i32 %rhs) {\n  ret i32 %lhs\n}\ndefine i32 @main(i32 %rhs) {\n  %v = call i32 @add(i32 1, i32 %rhs)\n  %w = call i32 (ptr, ...) @printf(ptr null, i32 %v)\n  ret i32 %w\n}');
  const all = new Range(doc.positionAt(0), doc.positionAt(doc.text.length));
  const names = providers.inlays.provideInlayHints(doc, all).filter(hint => hint.kind === 'Parameter');
  assert.deepEqual(names.map(hint => hint.label), ['lhs:', 'format:'], 'same-named and variadic arguments get no hint');
  assert.deepEqual(names[0].position, doc.at('i32 1'));
  assert.equal(names[0].paddingRight, true);
  settings['libraryHelp.enabled'] = false;
  assert.deepEqual(providers.inlays.provideInlayHints(doc, all).filter(hint => hint.kind === 'Parameter').map(hint => hint.label), ['lhs:']);
  settings['inlayHints.parameterNames'] = false;
  assert.equal(providers.inlays.provideInlayHints(doc, all).some(hint => hint.kind === 'Parameter'), false);
  providers.dispose();
});

test('code lenses count references to functions, globals and types', async () => {
  const providers = extension.createProviders();
  const doc = document('%T = type { i32 }\n@g = global i32 0\ndeclare void @unused()\ndefine void @f(ptr %p) {\n  %v = load i32, ptr @g\n  store i32 %v, ptr @g\n  %q = getelementptr %T, ptr %p, i32 0\n  ret void\n}');
  const all = providers.lenses.provideCodeLenses(doc);
  const graph = all.filter(lens => lens.command?.command === 'llvmIR.showControlFlowGraph');
  assert.equal(graph.length, 1, 'only defined functions have a graph');
  assert.equal(graph[0].command.title, 'Control-flow graph');
  const lenses = all.filter(lens => !lens.command);
  assert.equal(lenses.length, 4);
  const titles = [];
  for (const lens of lenses) titles.push((await providers.lenses.resolveCodeLens(lens)).command.title);
  assert.deepEqual(titles, ['1 reference', '2 references', '0 references', '0 references']);
  assert.equal(lenses[1].command.command, 'editor.action.showReferences');
  assert.equal(lenses[1].command.arguments[2].length, 2);
  settings['codeLens.references'] = false;
  settings['codeLens.controlFlowGraph'] = false;
  assert.deepEqual(providers.lenses.provideCodeLenses(doc), []);
  providers.dispose();
});

test('workspace code lenses count calls in other files', async () => {
  const doc = document('define i32 @twice(i32 %x) {\n  ret i32 %x\n}', 'impl.ll');
  const user = document('declare i32 @twice(i32)\ndefine i32 @main() {\n  %a = call i32 @twice(i32 1)\n  %b = call i32 @twice(i32 %a)\n  ret i32 %b\n}', 'user.ll');
  const { providers } = workspaceProviders(doc, [user]);
  const [lens] = providers.lenses.provideCodeLenses(doc);
  assert.equal((await providers.lenses.resolveCodeLens(lens)).command.title, '2 references');
  providers.dispose();
});

test('completion details add context without repeating function signatures or label filler', () => {
  const providers = extension.createProviders(), doc = document(ir);
  // At an opcode, not an operand, so every visible symbol and keyword is offered.
  const items = providers.completion.provideCompletionItems(doc, doc.at('br label', 2));
  const label = items.find(item => item.label === '%"exit block"');
  assert.equal(label.detail, 'Basic block · Line 8 in @first');
  assert.equal(label.documentation, undefined);
  const fn = items.find(item => item.label === '@printf');
  assert.match(fn.detail, /@printf/);
  assert.equal(fn.documentation.value, 'Line 2');
  const param = items.find(item => item.label === '%p');
  assert.equal(param.detail, 'ptr · Parameter');
  assert.equal(param.documentation.value, 'Line 3 in @first');
  const keyword = items.find(item => item.label === 'icmp');
  assert.equal(keyword.detail, undefined);
  assert.match(keyword.documentation.value, /samesign/);
  providers.dispose();
});

test('large source previews are bounded, explicitly truncated, and preserve Unicode boundaries', () => {
  const providers = extension.createProviders();
  const prefix = '@blob = constant [2000 x i8] c"';
  const doc = document(prefix + 'x'.repeat(999 - prefix.length) + '😀' + 'y'.repeat(1200) + '"');
  const hover = providers.hover.provideHover(doc, doc.at('@blob', 2));
  const code = hover.contents.value.split('```llvm-ir\n')[1].split('\n```')[0];
  assert.ok(code.length <= 1000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(code));
  assert.match(hover.contents.value, /Preview truncated.*Go to Definition/);
  assert.equal(hover.contents.isTrusted, false);
  const multi = document('declare void @many(\n' + Array.from({ length: 20 }, (_, i) => ' i32 %p' + i).join(',\n') + '\n)');
  const multiline = providers.hover.provideHover(multi, multi.at('@many', 2)).contents.value;
  const preview = multiline.split('```llvm-ir\n')[1].split('\n```')[0];
  assert.ok(preview.split('\n').length <= 10);
  assert.match(multiline, /Preview truncated/);
  providers.dispose();
});

test('definition and references resolve types and same-spelled locals by identity', () => {
  const providers = extension.createProviders(), doc = document(ir);
  const definition = providers.definition.provideDefinition(doc, doc.at('ret i32 %Node', 10));
  assert.equal(definition.range.start.line, 4);
  const refs = providers.references.provideReferences(doc, doc.at('%value, ptr', 3), { includeDeclaration: true });
  assert.equal(refs.length, 2);
  assert.ok(refs.every(reference => reference.range.start.line < 10));
  const typed = document('%T = type { i32 }\ndefine void @f(%T %T) {\n ret void\n}');
  const typeDefinition = providers.definition.provideDefinition(typed, typed.at('@f(%T', 4));
  assert.equal(typeDefinition.range.start.line, 0);
  assert.equal(providers.references.provideReferences(typed, typed.at('%T =', 1), { includeDeclaration: true }).length, 2);
  providers.dispose();
});

test('rename preserves sigils, quoted labels and function scope while rejecting collisions and numeric names', () => {
  const providers = extension.createProviders(), doc = document(ir);
  const renamed = providers.rename.provideRenameEdits(doc, doc.at('%value, ptr', 2), '%renamed');
  assert.equal(renamed.edits.length, 2);
  assert.ok(renamed.edits.every(edit => edit.newText === '%renamed' && edit.range.start.line < 10));
  assert.throws(() => providers.rename.provideRenameEdits(doc, doc.at('%value, ptr', 2), 'entry'), /same scope/);
  assert.throws(() => providers.rename.provideRenameEdits(doc, doc.at('%value, ptr', 2), '"Node"'), /same scope/);
  assert.throws(() => providers.rename.provideRenameEdits(doc, doc.at('%value, ptr', 2), '4'), /Numeric/);
  assert.throws(() => providers.rename.provideRenameEdits(doc, doc.at('%value, ptr', 2), '@bad'), /sigil/);
  assert.throws(() => providers.rename.prepareRename(doc, doc.at('; add %value', 9)), /No LLVM symbol/);
  const labelPosition = doc.at('"exit block":', 3);
  assert.match(providers.hover.provideHover(doc, labelPosition).contents.value, /\(label\) %"exit block"/);
  const label = providers.rename.provideRenameEdits(doc, labelPosition, '%"new block"');
  assert.deepEqual(label.edits.map(edit => edit.newText), ['%"new block"', '"new block"']);
  const numeric = document('define i32 @0(i32 %0) {\n  ret i32 %0\n}');
  assert.throws(() => providers.rename.prepareRename(numeric, numeric.at('%0', 1)), /structural numbering/);
  assert.throws(() => providers.rename.prepareRename(numeric, numeric.at('@0', 1)), /structural numbering/);
  providers.dispose();
});

test('document structure, semantic tokens, inlays, formatting and cache honor document state', () => {
  const cache = new Map(), providers = extension.createProviders(cache), doc = document(ir);
  const symbols = providers.symbols.provideDocumentSymbols(doc);
  const first = symbols.find(symbol => symbol.name === '@first');
  assert.ok(first.children.some(symbol => symbol.name === '%value'));
  assert.ok(first.children.some(symbol => symbol.name === '%"exit block"'));
  for (const symbol of [first, ...first.children]) assert.ok(symbol.range.contains(symbol.selectionRange));
  assert.ok(providers.folding.provideFoldingRanges(doc).length >= 2);
  const rows = providers.semantic.provideDocumentSemanticTokens(doc).rows;
  assert.ok(rows.length > 10);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][0] > rows[i - 1][0] || rows[i][0] === rows[i - 1][0] && rows[i][1] >= rows[i - 1][1] + rows[i - 1][2]);
  assert.ok(rows.every(row => row[0] < 16));
  assert.ok(rows.filter(row => row[0] === 15).every(row => row[1] === 0));
  const range = new Range(new Position(4, 0), new Position(4, 100));
  const hints = providers.inlays.provideInlayHints(doc, range);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].label, ': i32');
  settings['inlayHints.enabled'] = false;
  assert.deepEqual(providers.inlays.provideInlayHints(doc, range), [], 'the setting disables hints');
  settings['semanticHighlighting.enabled'] = false;
  assert.deepEqual(providers.semantic.provideDocumentSemanticTokens(doc).rows, []);
  const formatted = document('define void @f() {\n  ret void\n}\n');
  assert.deepEqual(providers.formatting.provideDocumentFormattingEdits(formatted, { tabSize: 2, insertSpaces: true }), []);
  formatted.text = 'define void @f() {\nret void  \n}\n'; formatted.version++;
  assert.equal(providers.formatting.provideDocumentFormattingEdits(formatted, { tabSize: 2, insertSpaces: true })[0].newText, 'define void @f() {\n  ret void\n}\n');
  const cached = cache.get(doc.uri.toString());
  doc.text = doc.text.replace('%Node = add i32', '%Node = add i64'); doc.version++;
  assert.match(providers.hover.provideHover(doc, doc.at('%Node = add', 2)).contents.value, /\(variable\) %Node: i64/);
  assert.notEqual(cache.get(doc.uri.toString()), cached);
  providers.dispose(); assert.equal(cache.size, 0);
});

test('folding preserves nested region markers while ignoring string contents', () => {
  const providers = extension.createProviders();
  const doc = document(';region outer\n; #region inner\n@x = constant [8 x i8] c";region"\n; #endregion\n;endregion\n');
  assert.deepEqual(providers.folding.provideFoldingRanges(doc).map(range => [range.start, range.end]), [[0, 4], [1, 3]]);
  providers.dispose();
});

test('semantic label coloring covers definitions, branch, phi, switch and blockaddress references', () => {
  const providers = extension.createProviders();
  const lines = [
    '@address = constant ptr blockaddress(@f, %"finish block")',
    '@text = constant [15 x i8] c"entry left 2"',
    'define i32 @f(i1 %condition, i32 %value) {',
    'entry:',
    ' br i1 %condition, label %left, label %2',
    'left:',
    ' br label %"finish block"',
    '2:',
    ' switch i32 %value, label %"finish block" [',
    '   i32 0, label %left',
    ' ]',
    '"finish block":',
    ' %result = phi i32 [ 1, %left ], [ 2, %2 ]',
    ' ret i32 %result ; entry: %left %2 %"finish block"',
    '}'
  ];
  const doc = document(lines.join('\n'));
  const rows = providers.semantic.provideDocumentSemanticTokens(doc).rows;
  const expected = [
    [0, '%"finish block"'], [3, 'entry'], [4, '%left'], [4, '%2'],
    [5, 'left'], [6, '%"finish block"'], [7, '2'], [8, '%"finish block"'],
    [9, '%left'], [11, '"finish block"'], [12, '%left'], [12, '%2']
  ].map(([line, spelling]) => [line, lines[line].indexOf(spelling), spelling.length, 4, 0]);
  assert.deepEqual(rows.filter(row => row[3] === 4), expected);
  assert.ok(rows.filter(row => row[0] === 1).every(row => row[1] === 0), 'ordinary strings are not semantic symbols');
  assert.ok(rows.filter(row => row[0] === 13).every(row => row[1] < lines[13].indexOf(';')), 'comment text is not colored as labels');
  const reference = doc.at('%"finish block"', 3);
  assert.equal(providers.definition.provideDefinition(doc, reference).range.start.line, 11);
  assert.equal(providers.references.provideReferences(doc, reference, { includeDeclaration: true }).length, 4);
  const renamed = providers.rename.provideRenameEdits(doc, reference, 'finish').edits;
  assert.equal(renamed.length, 4);
  assert.equal(renamed.find(edit => edit.range.start.line === 11).newText, 'finish');
  providers.dispose();
});

test('block folds keep label headers and braces visible with exact CRLF and multiline-switch bounds', () => {
  const providers = extension.createProviders();
  const lines = [
    ';region outer',
    'define void @f(i32 %value) {',
    'entry:',
    ' switch i32 %value, label %left [',
    '   i32 0, label %"exit block"',
    ' ]',
    '',
    'left:',
    ' ; fake_label: and "another label": are only comments',
    ' br label %"exit block"',
    '',
    '"exit block":',
    ' ret void',
    '  \t',
    '}',
    'define void @g() {',
    '2:',
    ' br label %3',
    '3:',
    ' ret void',
    '}',
    ';endregion'
  ];
  for (const newline of ['\n', '\r\n']) {
    const doc = document(lines.join(newline));
    const ranges = providers.folding.provideFoldingRanges(doc).map(range => [range.start, range.end]);
    assert.deepEqual(ranges, [[0, 21], [1, 13], [2, 5], [7, 9], [11, 12], [15, 19], [16, 17], [18, 19]]);
  }
  providers.dispose();
});

test('empty, consecutive and inline label blocks do not produce invalid folds', () => {
  const providers = extension.createProviders();
  const doc = document('define void @f() {\nempty:\nnext:\ninline: ret void\n}\ndefine void @g() { same: other: ret void }\n');
  assert.deepEqual(providers.folding.provideFoldingRanges(doc).map(range => [range.start, range.end]), [[0, 3]]);
  const inline = document('define void @inline() { first: second:\n ret void\n}\n');
  assert.deepEqual(providers.folding.provideFoldingRanges(inline).map(range => [range.start, range.end]), [[0, 1]], 'coincident function and inline-block folds are deduplicated');
  providers.dispose();
});

test('rename collision checks compare UTF-8 quoted escapes and distinguish numeric IDs from names', () => {
  const providers = extension.createProviders();
  const doc = document('define void @f(i32 %x, i32 %"é", i32 %0) {\n ret void\n}');
  assert.throws(() => providers.rename.provideRenameEdits(doc, doc.at('%x', 1), '"\\C3\\A9"'), /same scope/);
  const edits = providers.rename.provideRenameEdits(doc, doc.at('%x', 1), '"0"');
  assert.equal(edits.edits[0].newText, '%"0"');
  providers.dispose();
});

test('rename updates equivalent bare, quoted, and hexadecimal identifier spellings', () => {
  const providers = extension.createProviders();
  const doc = document('define i32 @f(i32 %x) {\nentry:\n %sum = add i32 %"x", %"\\78"\n ret i32 %sum\n}\n');
  const edits = providers.rename.provideRenameEdits(doc, doc.at('%x', 1), 'value').edits;
  assert.deepEqual(edits.map(edit => doc.getText(edit.range)), ['%x', '%"x"', '%"\\78"']);
  assert.ok(edits.every(edit => edit.newText === '%value'));
  providers.dispose();
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const issue = { start: 0, end: 1, message: 'invalid instruction', severity: 'error' };
function verificationFixture() {
  const diagnostics = collection(), logs = [], pending = [];
  const verifier = (text, options) => new Promise(resolve => pending.push({ text, options, resolve }));
  const manager = extension.createVerificationManager(diagnostics, { appendLine: line => logs.push(line) }, verifier);
  return { diagnostics, logs, pending, manager, doc: document('ret void') };
}

test('verification cancels superseded work and discards stale versions, settings and closed documents', async () => {
  const { manager, diagnostics, pending, doc } = verificationFixture();
  const first = manager.verify(doc);
  doc.version++; doc.text = 'ret i32 0';
  const second = manager.verify(doc);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ issues: [issue] });
  assert.equal((await first).cancelled, true);
  assert.equal(diagnostics.values.size, 0);
  pending[1].resolve({ issues: [issue] }); await second;
  assert.equal(diagnostics.values.get(doc.uri.toString()).length, 1);
  const third = manager.verify(doc);
  settings['diagnostics.enabled'] = false;
  manager.schedule(doc);
  assert.equal(pending[2].options.signal.aborted, true);
  assert.equal(diagnostics.values.size, 0);
  pending[2].resolve({ issues: [issue] }); assert.equal((await third).cancelled, true);
  await manager.verify(doc); assert.equal(pending.length, 3);
  settings['diagnostics.enabled'] = true;
  const fourth = manager.verify(doc); manager.close(doc);
  pending[3].resolve({ issues: [issue] }); assert.equal((await fourth).cancelled, true);
  assert.equal(diagnostics.values.size, 0);
  manager.dispose();
});

test('verification gates subprocesses on trust and refreshes compiler configuration', async () => {
  const { manager, diagnostics, pending, doc } = verificationFixture();
  mock.workspace.isTrusted = false;
  await manager.verify(doc); manager.schedule(doc, true); await tick();
  assert.equal(pending.length, 0);
  mock.workspace.isTrusted = true;
  manager.schedule(doc, true); await tick();
  assert.equal(pending[0].options.executable, 'llvm-as');
  settings.llvmAsPath = '/custom/llvm-as'; settings['diagnostics.timeout'] = 1234;
  manager.schedule(doc, true); await tick();
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(pending[1].options.executable, '/custom/llvm-as');
  assert.equal(pending[1].options.timeoutMs, 1234);
  pending[0].resolve({ issues: [issue] });
  mock.workspace.isTrusted = false;
  pending[1].resolve({ issues: [issue] }); await tick();
  assert.equal(diagnostics.values.size, 0);
  manager.dispose();
});

test('verification logs unavailable compiler without source or automatic popups, and disposes timers', async () => {
  const { manager, logs, pending, doc } = verificationFixture();
  manager.schedule(doc, true); await tick();
  pending[0].resolve({ issues: [], unavailable: 'compiler error: secret IR source' }); await tick();
  assert.equal(logs.length, 1); assert.doesNotMatch(logs[0], /secret IR source/);
  assert.equal(notifications.length, 0);
  const explicit = manager.verify(doc);
  pending[1].resolve({ issues: [] });
  assert.deepEqual(await explicit, { issues: [] });
  assert.match(notifications[0], /succeeded/);
  manager.schedule(doc, true); manager.dispose(); await tick();
  assert.equal(pending.length, 2);
});

test('automatic verification skips large documents but explicit verification remains available', async () => {
  const { manager, logs, pending, doc } = verificationFixture();
  doc.text = ';' + 'a'.repeat(2 * 1024 * 1024);
  manager.schedule(doc, true); await tick();
  assert.equal(pending.length, 0); assert.match(logs[0], /2 MiB/);
  const result = manager.verify(doc);
  pending[0].resolve({ issues: [] }); await result;
  manager.dispose();
});

test('activation registers all schemes and disposes providers and listeners', () => {
  const context = { subscriptions: [] };
  extension.activate(context);
  assert.deepEqual(registrations.get('Hover').selector, { language: 'llvm-ir' });
  assert.deepEqual(registrations.get('CompletionItem').args, ['@', '%']);
  assert.ok(registrations.has('llvmIR.verify'));
  assert.ok(registrations.has('llvmIR.verifyWorkspace'));
  assert.deepEqual(registrations.get('CodeActions').args, [{ providedCodeActionKinds: ['QuickFix'] }]);
  assert.ok(workspaceEvents.has('GrantWorkspaceTrust'));
  extension.deactivate();
  assert.equal(registrations.size, 0);
  assert.equal(workspaceEvents.size, 0);
  context.subscriptions[0].dispose();
});

function workspaceProviders(doc, others = []) {
  const { WorkspaceIndex } = require('../src/workspace-index');
  const index = new WorkspaceIndex();
  for (const other of others) index.upsert(other.uri.toString(), other.text, { root: 'test-root', version: other.version });
  const service = { index, async ensure(current) { index.upsert(current.uri.toString(), current.text, { root: 'test-root', version: current.version }); },
    async ready() {}, status: () => ({ complete: true }), async validateEdits() { return true; } };
  index.upsert(doc.uri.toString(), doc.text, { root: 'test-root', version: doc.version });
  return { providers: extension.createProviders(new Map(), service), service };
}

test('workspace providers map unopened UTF-16 locations and keep local symbols isolated', async () => {
  const doc = document('declare i32 @twice(i32)\ndefine i32 @main() {\nentry:\n %v = call i32 @twice(i32 2)\n ret i32 %v\n}', 'entry.ll');
  const other = document('; 😀\ndefine i32 @twice(i32 %x) {\n ret i32 %x\n}', 'impl.ll');
  const { providers } = workspaceProviders(doc, [other]);
  const defs = await providers.definition.provideDefinition(doc, doc.at('@twice', 2));
  assert.equal(defs.length, 1); assert.equal(defs[0].uri.toString(), other.uri.toString());
  assert.deepEqual(defs[0].range.start, other.at('@twice'));
  const refs = await providers.references.provideReferences(doc, doc.at('@twice', 2), { includeDeclaration: true });
  assert.equal(refs.length, 3);
  const local = await providers.definition.provideDefinition(doc, doc.at('i32 %v', 5));
  assert.equal(local[0].uri.toString(), doc.uri.toString());
  assert.match((await providers.hover.provideHover(doc, doc.at('@twice', 2))).contents.value, /impl.ll:2/);
  const symbols = await providers.workspaceSymbols.provideWorkspaceSymbols('twice');
  assert.equal(symbols.length, 2);
  providers.dispose();
});

test('workspace rename is atomic and rejects stale, incomplete, or cancelled plans', async () => {
  const doc = document('declare i32 @twice(i32)', 'entry.ll');
  const other = document('define i32 @twice(i32 %x) { ret i32 %x }', 'impl.ll');
  const { providers, service } = workspaceProviders(doc, [other]);
  const rename = () => providers.rename.provideRenameEdits(doc, doc.at('@twice', 2), 'double_it');
  assert.equal((await rename()).edits.length, 2);
  service.validateEdits = async () => false;
  await assert.rejects(rename(), /changed during rename/);
  service.validateEdits = async () => true;
  service.status = () => ({ complete: false, reason: 'file limit' });
  await assert.rejects(rename(), /complete workspace index.*file limit/);
  await assert.rejects(providers.rename.provideRenameEdits(doc, doc.at('@twice', 2), 'x', { isCancellationRequested: true }), /cancelled/);
  service.rootFor = () => doc.uri.toString();
  await assert.rejects(rename(), /isolated documents/);
  providers.dispose();
});

test('library hovers preserve declarations, document printf formats, and enrich signature parameters', async () => {
  const doc = document(ir), { providers } = workspaceProviders(doc);
  const hover = await providers.hover.provideHover(doc, doc.at('@printf', 2));
  assert.match(hover.contents.value, /noundef %fmt/);
  assert.match(hover.contents.value, /%zu/);
  assert.match(hover.contents.value, /_@param_ `format` — Pointer to the format string/);
  assert.match(hover.contents.value, /_@returns_ Number of bytes/);
  assert.match(hover.contents.value, /```\n\n\n---\n\nWrites formatted output/, 'documentation follows the signature rule');
  assert.equal((hover.contents.value.match(/```llvm-ir/g) || []).length, 1);
  assert.equal(hover.contents.isTrusted, false);
  const help = await providers.signatures.provideSignatureHelp(doc, doc.at('i32 9)', 5));
  assert.match(help.signatures[0].documentation.value, /formatted output/);
  assert.match(help.signatures[0].parameters[0].documentation.value, /format string/);
  const items = await providers.completion.provideCompletionItems(doc, doc.at('@printf', 2));
  assert.match(items.find(item => item.label === '@printf').documentation.value, /formatted output/);
  settings['libraryHelp.enabled'] = false;
  assert.doesNotMatch((await providers.hover.provideHover(doc, doc.at('@printf', 2))).contents.value, /C library/);
  providers.dispose();
});

test('known user implementations suppress libc semantics; ambiguous definitions are not guessed', async () => {
  const doc = document('declare i32 @printf(ptr, ...)\ndeclare i32 @twice(i32)', 'entry.ll');
  const other = document('define i32 @printf(ptr %p, ...) { ret i32 0 }\ndefine i32 @twice(i32 %x) { ret i32 %x }', 'impl.ll');
  const duplicate = document('define i32 @twice(i32 %x) { ret i32 %x }', 'duplicate.ll');
  const { providers } = workspaceProviders(doc, [other, duplicate]);
  const printf = (await providers.hover.provideHover(doc, doc.at('@printf', 2))).contents.value;
  assert.match(printf, /Definition:.*impl.ll/); assert.doesNotMatch(printf, /C library|stdout/);
  const twice = (await providers.hover.provideHover(doc, doc.at('@twice', 2))).contents.value;
  assert.match(twice, /2 candidate definitions/); assert.match(twice, /duplicate.ll/);
  providers.dispose();
});

test('external completion adds the agreed declaration, and only the name when it cannot be derived', async () => {
  const doc = document('declare i32 @puts(ptr)\n\ndefine void @main() {\n call void @\n ret void\n}', 'entry.ll');
  const other = document('define dso_local void @remote_only(i32 noundef signext %x) #0 { ret void }\n%T = type { i32 }\ndefine void @typed(%T %t) { ret void }\n@count = dso_local global i32 0, align 4', 'impl.ll');
  const { providers } = workspaceProviders(doc, [other]);
  const items = await providers.completion.provideCompletionItems(doc, doc.at('void @\n', 6));
  const item = items.find(item => item.label === '@remote_only');
  assert.match(item.detail, /adds declaration/);
  assert.equal(item.insertText, '@remote_only');
  assert.equal(item.additionalTextEdits.length, 1);
  assert.equal(item.additionalTextEdits[0].newText, '\ndeclare void @remote_only(i32 noundef signext)');
  assert.deepEqual(item.additionalTextEdits[0].range.start, doc.at('\n\ndefine'));
  assert.match(item.documentation.value, /```llvm-ir\ndeclare void @remote_only/);
  const typed = items.find(item => item.label === '@typed');
  assert.match(typed.detail, /declaration required/);
  assert.equal(typed.additionalTextEdits, undefined);
  assert.equal(items.some(item => item.label === '@count'), false, 'a callee is a function');
  const empty = document('define void @main() {\n store i32 1, ptr @\n ret void\n}', 'bare.ll');
  const { providers: bare } = workspaceProviders(empty, [other]);
  const global = (await bare.completion.provideCompletionItems(empty, empty.at('ptr @', 5))).find(item => item.label === '@count');
  assert.equal(global.additionalTextEdits[0].newText, '@count = external global i32\n\n');
  assert.deepEqual(global.additionalTextEdits[0].range.start, empty.at('define'));
  const conflicting = document('define void @remote_only(i64 %x) { ret void }', 'other.ll');
  const { providers: ambiguous } = workspaceProviders(doc, [other, conflicting]);
  const unknown = (await ambiguous.completion.provideCompletionItems(doc, doc.at('void @\n', 6))).find(item => item.label === '@remote_only');
  assert.equal(unknown.additionalTextEdits, undefined);
  providers.dispose(); bare.dispose(); ambiguous.dispose();
});

test('workspace wrappers preserve comment/string blocking and discard a changed request document', async () => {
  const doc = document('declare i32 @printf(ptr, ...)\n; @printf\n@str = constant [8 x i8] c"@printf"');
  const { providers, service } = workspaceProviders(doc);
  assert.equal(await providers.hover.provideHover(doc, doc.at('; @printf', 4)), undefined);
  assert.equal(await providers.definition.provideDefinition(doc, doc.at('c"@printf', 4)), undefined);
  assert.deepEqual(await providers.completion.provideCompletionItems(doc, doc.at('; @printf', 5)), []);
  const original = service.ensure;
  service.ensure = async current => { await original(current); current.version++; };
  assert.equal(await providers.hover.provideHover(doc, doc.at('@printf', 2)), undefined);
  providers.dispose();
});

test('cross-file ranges handle CR-only files and external declarations are not called definitions', async () => {
  const doc = document('define void @main() {\n call void @external()\n ret void\n}', 'entry.ll');
  const other = document('; heading\rdeclare void @external()\r', 'decl.ll');
  const { providers } = workspaceProviders(doc, [other]);
  const defs = await providers.definition.provideDefinition(doc, doc.at('@external', 2));
  assert.deepEqual(defs[0].range.start, new Position(1, 13));
  const hover = (await providers.hover.provideHover(doc, doc.at('@external', 2))).contents.value;
  assert.match(hover, /Declaration:.*decl.ll:2/);
  assert.doesNotMatch(hover, /Definition:/);
  providers.dispose();
});

test('lifetime signature documentation follows modern versus historical argument order', async () => {
  for (const [prototype, call, expected] of [
    ['declare void @llvm.lifetime.start.p0(i64, ptr)', 'call void @llvm.lifetime.start.p0(i64 4, ptr %p)', /i64 byte count/],
    ['declare void @llvm.lifetime.start(ptr)', 'call void @llvm.lifetime.start(ptr %p)', /Stack allocation/]
  ]) {
    const doc = document(prototype + '\ndefine void @f(ptr %p) {\n ' + call + '\n ret void\n}');
    const { providers } = workspaceProviders(doc);
    const help = await providers.signatures.provideSignatureHelp(doc, doc.at(call, call.indexOf('(') + 1));
    assert.match(help.signatures[0].parameters[0].documentation.value, expected);
    providers.dispose();
  }
});

test('local hovers and navigation stay responsive during workspace discovery', async () => {
  const doc = document('define i32 @f(i32 %x) {\n ret i32 %x\n}');
  const { providers, service } = workspaceProviders(doc);
  service.sync = current => service.index.upsert(current.uri.toString(), current.text, { root: 'test-root', version: current.version });
  service.ensure = async () => { throw new Error('Local operations should not await discovery'); };
  const position = doc.at('ret i32 %x', 9);
  assert.match((await providers.hover.provideHover(doc, position)).contents.value, /\(parameter\) %x: i32/);
  assert.equal((await providers.definition.provideDefinition(doc, position)).length, 1);
  assert.equal((await providers.references.provideReferences(doc, position, { includeDeclaration: true })).length, 2);
  assert.equal((await providers.rename.provideRenameEdits(doc, position, 'value')).edits.length, 2);
  providers.dispose();
});

test('quick fixes correct misspelled names and spell a variadic function type', () => {
  const providers = extension.createProviders();
  const doc = document('declare i32 @printf(ptr, ...)\n@s = constant [1 x i8] zeroinitializer\ndefine i32 @f(i32 %count) {\n  %n = ad i32 %cuont, 1\n  %r = call i32 @printf(ptr @s)\n  ret i32 %n\n}');
  const at = (needle, delta = 1) => { const position = doc.at(needle, delta); return providers.codeActions.provideCodeActions(doc, new Range(position, position), { diagnostics: [] }); };
  const [rename] = at('%cuont');
  assert.equal(rename.title, 'Change to %count');
  assert.equal(rename.kind, 'QuickFix');
  assert.deepEqual(rename.edit.edits.map(edit => [doc.getText(edit.range), edit.newText]), [['%cuont', '%count']]);
  assert.equal(at('ad i32')[0].title, 'Change to add');
  const [type] = at('@printf(ptr @s)');
  assert.equal(type.title, 'Spell the function type (ptr, ...)');
  assert.equal(type.edit.edits[0].newText, '(ptr, ...) ');
  assert.deepEqual(type.edit.edits[0].range.start, doc.at('@printf(ptr @s)'));
  assert.deepEqual(at('ret i32'), []);
  providers.dispose();
});

test('an undefined global offers the declaration its workspace definition implies', async () => {
  const doc = document('declare void @other()\n\ndefine void @main() {\n  call void @helper(i32 1)\n  ret void\n}', 'entry.ll');
  const impl = document('define void @helper(i32 %x) {\n  ret void\n}', 'impl.ll');
  const { providers } = workspaceProviders(doc, [impl]);
  const position = doc.at('@helper', 2);
  const actions = providers.codeActions.provideCodeActions(doc, new Range(position, position), { diagnostics: [{ code: 'undefined-value', range: new Range(position, position) }] });
  const add = actions.find(action => action.title.startsWith('Add declaration'));
  assert.match(add.title, /Add declaration of @helper from untitled:impl.ll:1/);
  assert.equal(add.edit.edits[0].newText, '\ndeclare void @helper(i32)');
  assert.deepEqual(add.edit.edits[0].range.start, doc.at('\n\ndefine'));
  assert.equal(add.diagnostics.length, 1);
  providers.dispose();
});

function checkFixture(index) {
  const { createCheckManager } = require('../src/check-manager');
  const published = collection();
  const providers = extension.createProviders();
  const manager = createCheckManager(mock, { collection: published, analyze: providers.analyze, index, delay: 0 });
  return { manager, published, providers };
}

test('built-in checks publish severities, codes, tags and related definitions', () => {
  const { manager, published, providers } = checkFixture();
  const doc = document('@g = global i32 0\n@g = global i32 1\ndefine i32 @f(i32 %a) {\n  %unused = add i32 %a, 1\n  ret i32 %b\n}');
  manager.schedule(doc, true);
  const diagnostics = published.values.get(doc.uri.toString());
  const byCode = code => diagnostics.find(diagnostic => diagnostic.code === code);
  assert.equal(byCode('undefined-value').severity, 'Error');
  assert.equal(byCode('undefined-value').source, 'llvm-ir');
  assert.deepEqual(byCode('unused-value').tags, ['Unnecessary']);
  assert.equal(byCode('unused-value').severity, 'Hint');
  assert.equal(byCode('duplicate-definition').relatedInformation[0].message, 'First definition of @g');
  // llvm-as already reports line 5, so only the built-in hint and duplicate remain.
  manager.setCompilerIssues(doc.uri, new Set([4]));
  assert.equal(published.values.get(doc.uri.toString()).some(diagnostic => diagnostic.code === 'undefined-value'), false);
  manager.setCompilerIssues(doc.uri, undefined);
  assert.ok(published.values.get(doc.uri.toString()).some(diagnostic => diagnostic.code === 'undefined-value'));
  settings['diagnostics.builtIn'] = false;
  manager.schedule(doc, true);
  assert.equal(published.values.has(doc.uri.toString()), false);
  manager.dispose(); providers.dispose();
});

test('workspace scope checks unopened indexed files and follows index changes', async () => {
  const { WorkspaceIndex } = require('../src/workspace-index');
  const index = new WorkspaceIndex();
  const { manager, published, providers } = checkFixture(index);
  const uri = 'file:///w/lib.ll', tick = () => new Promise(resolve => setTimeout(resolve, 5));
  index.upsert(uri, 'define i32 @f() {\n  ret i32 %missing\n}', { root: 'r' });
  await tick();
  assert.equal(published.values.has(uri), false, 'open files only by default');
  settings['diagnostics.scope'] = 'workspace';
  manager.refresh();
  const [diagnostic] = published.values.get(uri);
  assert.equal(diagnostic.code, 'undefined-value');
  assert.deepEqual(diagnostic.range.start, new Position(1, 10));
  index.upsert(uri, 'define i32 @f() {\n  ret i32 0\n}', { root: 'r' });
  await tick();
  assert.deepEqual(published.values.get(uri), []);
  index.remove(uri);
  await tick();
  assert.equal(published.values.has(uri), false);
  manager.dispose(); providers.dispose();
});

test('Verify Workspace runs llvm-as on unopened files and summarizes failures', async () => {
  const published = collection(), lines = [];
  const verifier = async text => ({ issues: text.includes('bad') ? [{ start: 0, end: 3, message: 'bad', severity: 'error' }] : [] });
  const manager = extension.createVerificationManager(published, { appendLine() {} }, verifier, { onIssues: (uri, found) => lines.push([uri.toString(), found && [...found]]) });
  const { positionsIn } = require('../src/check-manager');
  const summary = await manager.verifyAll([{ uri: 'file:///a.ll', text: 'ok' }, { uri: 'file:///b.ll', text: 'bad' }], { positions: text => positionsIn(mock, text) });
  assert.deepEqual(summary, { checked: 2, failed: 1 });
  assert.equal(published.values.get('file:///b.ll')[0].source, 'llvm-as');
  assert.deepEqual(lines.at(-1), ['file:///b.ll', [0]]);
  manager.forget(mock.Uri.parse('file:///b.ll'));
  assert.equal(published.values.has('file:///b.ll'), false);
  mock.workspace.isTrusted = false;
  assert.match((await manager.verifyAll([{ uri: 'file:///a.ll', text: 'ok' }])).unavailable, /trusted/);
  manager.dispose();
});

test('Verify Workspace discards results for files that change, open or are disposed while llvm-as runs', async () => {
  const published = collection(), pending = [];
  const verifier = (text, options) => new Promise(resolve => pending.push({ text, options, resolve }));
  const { positionsIn } = require('../src/check-manager');
  const positions = text => positionsIn(mock, text);
  const bad = { issues: [{ start: 0, end: 3, message: 'bad', severity: 'error' }] };
  let manager = extension.createVerificationManager(published, { appendLine() {} }, verifier);
  // Invalidated mid-run: the file changed on disk.
  let run = manager.verifyAll([{ uri: 'file:///a.ll', text: 'bad' }], { positions });
  await tick();
  manager.forget(mock.Uri.parse('file:///a.ll'));
  pending[0].resolve(bad);
  assert.deepEqual(await run, { checked: 0, failed: 0 });
  assert.equal(published.values.has('file:///a.ll'), false);
  // The index replaced the snapshot while llvm-as ran.
  run = manager.verifyAll([{ uri: 'file:///a.ll', text: 'bad' }], { positions, isCurrent: () => false });
  await tick(); pending[1].resolve(bad); await run;
  assert.equal(published.values.has('file:///a.ll'), false);
  // Disposal aborts the running process and publishes nothing.
  run = manager.verifyAll([{ uri: 'file:///a.ll', text: 'bad' }, { uri: 'file:///b.ll', text: 'bad' }], { positions });
  await tick();
  manager.dispose();
  assert.equal(pending[2].options.signal.aborted, true);
  pending[2].resolve(bad);
  assert.equal((await run).cancelled, true);
  assert.equal(published.values.size, 0);
  assert.equal(pending.length, 3);
  // Cancellation aborts the file being verified, not only later ones.
  manager = extension.createVerificationManager(published, { appendLine() {} }, verifier);
  let cancel;
  const cancellation = { isCancellationRequested: false, onCancellationRequested: listener => { cancel = listener; return { dispose() {} }; } };
  run = manager.verifyAll([{ uri: 'file:///a.ll', text: 'bad' }], { positions, cancellation });
  await tick();
  cancellation.isCancellationRequested = true; cancel();
  assert.equal(pending[3].options.signal.aborted, true);
  pending[3].resolve({ issues: [], cancelled: true });
  assert.equal((await run).cancelled, true);
  manager.dispose();
});

test('verification reports why llvm-as is unavailable', async () => {
  const logs = [], results = [];
  const verifier = async () => ({ issues: [], unavailable: 'Cannot run llvm-as: spawn llvm-as ENOENT', reason: 'missing' });
  const manager = extension.createVerificationManager(collection(), { appendLine: line => logs.push(line) }, verifier, { onResult: result => results.push(result) });
  const summary = await manager.verifyAll([{ uri: 'file:///a.ll', text: 'ok' }], { positions: () => () => new Position(0, 0) });
  assert.equal(summary.reason, 'missing');
  await manager.verify(document('ret void'));
  assert.match(logs.at(-1), /not found/);
  assert.match(notifications.at(-1), /not found/);
  assert.equal(results.length, 2);
  manager.dispose();
});

test('the status items show the llvm-as version, verification failures, version mismatches and index state', async () => {
  const { createStatus } = require('../src/status');
  const { WorkspaceIndex } = require('../src/workspace-index');
  const items = new Map(), probes = [];
  const languages = { ...mock.languages, createLanguageStatusItem: id => { const item = { id, dispose() {} }; items.set(id, item); return item; } };
  const doc = document('ret void');
  const vscode = { ...mock, languages, window: { ...mock.window, activeTextEditor: { document: doc } } };
  const index = new WorkspaceIndex();
  let state = { complete: false, reason: 'A relevant file exceeds workspace.maxFileBytes.' };
  const workspace = { index, status: () => state, ready: async () => {} };
  const status = createStatus(vscode, { workspace, output: { appendLine() {} }, probe: async executable => { probes.push(executable); return { version: { major: 15, text: '15.0.7' } }; } });
  status.render();
  const toolchain = items.get('llvmIR.toolchain'), indexing = items.get('llvmIR.index');
  assert.equal(toolchain.busy, true);
  await tick();
  assert.equal(toolchain.text, 'LLVM 15.0.7');
  assert.match(indexing.text, /incomplete/);
  assert.equal(indexing.command.command, 'llvmIR.reindex');
  status.report({ issues: [], unavailable: 'x', reason: 'timeout' }, '', doc.uri);
  assert.match(toolchain.detail, /timed out/);
  status.report({ issues: [{ severity: 'error' }] }, '!0 = !{!"clang version 18.1.3"}', doc.uri);
  assert.match(toolchain.detail, /LLVM 18.*LLVM 15/);
  status.report({ issues: [] }, '', doc.uri);
  assert.equal(toolchain.severity, vscode.LanguageStatusSeverity.Information);
  state = { complete: true };
  status.render();
  assert.match(indexing.text, /Indexed 0 files/);
  assert.deepEqual(probes, ['llvm-as']);
  status.dispose();
});

test('the workspace index reuses the editor analysis of identical text', () => {
  const { WorkspaceIndex } = require('../src/workspace-index');
  const analyses = new Map();
  const index = new WorkspaceIndex({ analyze: (text, uri) => analyses.get(uri)?.text === text ? analyses.get(uri).value : require('../src/analysis').analyze(text) });
  const workspace = { index, status: () => ({ complete: true }), ensure: async () => {}, ready: async () => {}, rootFor: () => 'r' };
  const providers = extension.createProviders(analyses, workspace);
  const doc = document(ir);
  const local = providers.analyze(doc);
  assert.equal(index.upsert(doc.uri.toString(), ir, { root: 'r', version: 1 }).analysis, local);
  doc.version++; doc.text = ir + '\n';
  const snapshot = index.upsert(doc.uri.toString(), doc.text, { root: 'r', version: 2 });
  assert.equal(providers.analyze(doc), snapshot.analysis);
  providers.dispose();
});

const loop = ['define i32 @count(i32 %n) {', 'entry:', '  br label %loop', 'loop:', '  %i = phi i32 [ 0, %entry ], [ %next, %body ]',
  '  %c = icmp slt i32 %i, %n', '  br i1 %c, label %body, label %done', 'body:', '  %next = add i32 %i, 1', '  br label %loop',
  'done:                                             ; preds = %loop', '  ret i32 %i', 'dead:', '  ret i32 0', '}'].join('\n');

test('label hovers explain loops, dominators and unreachable blocks', () => {
  const providers = extension.createProviders(), doc = document(loop);
  const hover = needle => providers.hover.provideHover(doc, doc.at(needle)).contents.value;
  assert.match(hover('loop:'), /Predecessors: `%entry`, `%body`\n\nSuccessors: `%body`, `%done`\n\nLoop header: `%body` branches back here\.\n\nImmediate dominator: `%entry`/);
  assert.match(hover('entry:'), /Entry block: runs first, and nothing may branch to it\.\n\nSuccessors: `%loop`/);
  assert.match(hover('dead:'), /Unreachable: no path from the entry block leads here\.\n\nLeaves the function with `ret`\./);
  assert.doesNotMatch(hover('dead:'), /dominator/);
  providers.dispose();
});

test('predecessor inlay hints link each source block, skipping existing preds comments', () => {
  const providers = extension.createProviders(), doc = document(loop);
  const all = new Range(doc.positionAt(0), doc.positionAt(doc.text.length));
  const hints = providers.inlays.provideInlayHints(doc, all).filter(hint => Array.isArray(hint.label));
  assert.deepEqual(hints.map(hint => hint.label.map(part => part.value).join('')), ['preds: %entry, %body', 'preds: %loop']);
  assert.deepEqual(hints[0].position, doc.at('loop:', 5));
  assert.deepEqual(hints[0].label[3].location.range.start, doc.at('body:'));
  assert.equal(hints.some(hint => hint.position.line === doc.at('done:').line), false, 'clang already wrote preds there');
  settings['inlayHints.predecessors'] = false;
  assert.equal(providers.inlays.provideInlayHints(doc, all).some(hint => Array.isArray(hint.label)), false);
  providers.dispose();
});

test('label decorations use the contributed theme color and bold definitions', () => {
  const providers = extension.createProviders(), doc = document(loop), applied = new Map();
  const labels = extension.createLabelDecorations(providers.analyze);
  const editor = { document: doc, setDecorations: (style, ranges) => applied.set(style.options.fontWeight ? 'definitions' : 'references', ranges.map(range => doc.getText(range))) };
  labels.paint(editor);
  assert.deepEqual(applied.get('definitions'), ['entry', 'loop', 'body', 'done', 'dead']);
  // The %loop in clang's `; preds` comment is not a reference.
  assert.deepEqual(applied.get('references'), ['%loop', '%entry', '%body', '%body', '%done', '%loop']);
  settings['labels.highlight'] = false;
  labels.paint(editor);
  assert.deepEqual(applied.get('definitions'), []);
  labels.dispose(); providers.dispose();
});

test('the control-flow graph layout separates blocks and routes loops around them', () => {
  const { layoutGraph, renderGraph } = require('../src/cfg-view');
  const analysis = require('../src/analysis');
  const parsed = analysis.analyze(loop), graph = analysis.blockGraph(parsed, loop.indexOf('entry:'));
  assert.deepEqual(graph.blocks.map(block => [block.name, block.idom, block.backEdges]), [['%entry', undefined, []], ['%loop', 0, [2]], ['%body', 1, []], ['%done', 1, []], ['%dead', undefined, undefined]]);
  const layout = layoutGraph(graph, loop);
  const box = node => ({ left: node.x - node.width / 2, right: node.x + node.width / 2, top: node.y - 23, bottom: node.y + 23 });
  for (const a of layout.nodes) for (const b of layout.nodes) {
    if (a === b) continue;
    const p = box(a), q = box(b);
    assert.ok(p.right <= q.left || q.right <= p.left || p.bottom <= q.top || q.bottom <= p.top, `${a.name} overlaps ${b.name}`);
  }
  const rank = name => layout.nodes.find(node => node.name === name).y;
  assert.ok(rank('%entry') < rank('%loop') && rank('%loop') < rank('%body'), 'blocks flow downward');
  const [backEdge] = layout.edges.filter(edge => edge.kind === 'back');
  assert.deepEqual([backEdge.from, backEdge.to], [2, 1]);
  // Horizontal runs of a back edge never pass through a block.
  for (let i = 1; i < backEdge.points.length; i++) {
    const [[x0, y0], [x1, y1]] = [backEdge.points[i - 1], backEdge.points[i]];
    if (y0 !== y1) continue;
    for (const node of layout.nodes) {
      const b = box(node);
      assert.ok(!(y0 > b.top && y0 < b.bottom && Math.max(x0, x1) > b.left && Math.min(x0, x1) < b.right), `${node.name} crossed`);
    }
  }
  assert.deepEqual(layout.edges.filter(edge => edge.label).map(edge => [edge.from, edge.to, edge.label]), [[1, 2, 'T'], [1, 3, 'F']]);
  assert.equal(layout.nodes.find(node => node.name === '%dead').reachable, false);
  const html = renderGraph({ ...layout, nodes: [{ ...layout.nodes[0], name: '%"<b>"' }, ...layout.nodes.slice(1)] }, { title: '@count', cspSource: 'vscode-resource:', nonce: 'abc', selected: 1 });
  assert.match(html, /script-src 'nonce-abc'/);
  assert.match(html, /%&quot;&lt;b&gt;&quot;/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/, 'no remote resources');
  assert.match(html, /class="node loop selected" data-index="1"/);
});

test('the graph view follows the cursor and reveals clicked blocks', async () => {
  const { createGraphView } = require('../src/cfg-view');
  const providers = extension.createProviders(), doc = document(loop), posted = [], shown = [];
  let receive;
  const panel = { title: '', webview: { html: '', cspSource: 'vscode-resource:', postMessage: message => { posted.push(message); return Promise.resolve(true); }, onDidReceiveMessage: callback => { receive = callback; } },
    onDidDispose() {}, reveal() {}, dispose() {} };
  const editor = { document: doc, selection: { active: doc.at('entry:') }, viewColumn: 1, revealRange() {} };
  const fake = { ...mock, window: { ...mock.window, activeTextEditor: editor, visibleTextEditors: [editor], createWebviewPanel: () => panel,
    showTextDocument: async (document, options) => { shown.push(options.selection); return editor; } } };
  const view = createGraphView(fake, providers.analyze);
  await view.show();
  assert.equal(panel.title, 'CFG: @count');
  assert.match(panel.webview.html, /data-index="0"/);
  editor.selection = { active: doc.at('%next = add') };
  view.follow(editor);
  assert.deepEqual(posted, [{ type: 'select', index: 2 }]);
  receive({ type: 'reveal', index: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.getText(shown[0]), 'done');
  view.dispose(); providers.dispose();
});
