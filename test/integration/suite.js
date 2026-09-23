'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vscode = require('vscode');
const { courseFile } = require('../course-files');

const fixture = [
  '; @sum and %value in comments must stay untouched',
  '@message = constant [7 x i8] c"%value\\00"',
  'define i32 @sum(i32 %left, i32 %right) {',
  'entry:',
  '  %value = add i32 %left, %right',
  '  ret i32 %value',
  '}',
  'define i32 @main() {',
  'entry:',
  '  %value = call i32 @sum(i32 2, i32 3)',
  '  ret i32 %value',
  '}',
  ''
].join('\n');
function at(document, needle, delta = 0, from = 0) {
  const offset = document.getText().indexOf(needle, from);
  assert.notEqual(offset, -1, 'fixture must contain ' + needle);
  return document.positionAt(offset + delta);
}
function hoverText(hovers) {
  // appendText encodes spaces as entities; compare visible text, not its encoding.
  return (hovers || []).flatMap(h => h.contents).map(c => typeof c === 'string' ? c : c.value).join('\n').replace(/&nbsp;/g, ' ');
}
async function run() {
  const extension = vscode.extensions.getExtension('cse4100-local.llvm-ir-highlighter');
  assert.ok(extension, 'local extension discovered');
  await extension.activate();
  const themes = vscode.extensions.getExtension('vscode.theme-defaults');
  assert.ok(themes, 'built-in themes available for real palette verification');
  await require('../theme-colors').verifyThemeColors(path.join(themes.extensionPath, 'themes'));
  await vscode.workspace.getConfiguration('llvmIR').update('diagnostics.enabled', false, vscode.ConfigurationTarget.Global);
  const document = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: fixture });
  await vscode.window.showTextDocument(document);
  let hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, at(document, 'ret i32 %value', 10));
  assert.match(hoverText(hovers), /i32/);
  assert.match(hoverText(hovers), /%value/);
  assert.match(hoverText(hovers), /\(variable\) %value: i32 = add i32 %left, %right/);
  assert.equal((hoverText(hovers).match(/```llvm-ir/g) || []).length, 1, 'SSA hover has one source preview');
  hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, at(document, '= add', 3));
  assert.match(hoverText(hovers), /add|sum|integer/i);
  assert.match(hoverText(hovers), /llvm\.org/);
  hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, at(document, '@sum(i32 2', 2));
  assert.match(hoverText(hovers), /i32/);
  assert.match(hoverText(hovers), /%left/);
  assert.match(hoverText(hovers), /%right/);
  assert.equal(hoverText(hovers).trim(), '```llvm-ir\n(function) i32 @sum(i32 %left, i32 %right)\n```', 'function hover is one signature, without repeated metadata');
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, at(document, '@sum(i32 2', 2));
  assert.equal(definitions.length, 1);
  assert.equal((definitions[0].range || definitions[0].targetSelectionRange).start.line, 2);
  const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, at(document, '  %value = add', 4));
  assert.ok(refs.length >= 1);
  assert.ok(refs.every(ref => ref.range.start.line === 4 || ref.range.start.line === 5), 'references isolated to first function');
  const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, at(document, '%value = add', 2), 'result');
  const edits = rename.get(document.uri);
  assert.equal(edits.length, 2);
  assert.ok(edits.every(edit => edit.range.start.line === 4 || edit.range.start.line === 5));
  assert.ok(edits.every(edit => /result/.test(edit.newText)));
  const signatures = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, at(document, 'i32 3)', 4));
  assert.ok(signatures && signatures.signatures.length);
  assert.equal(signatures.activeParameter, 1);
  assert.equal(signatures.signatures[0].documentation.value.replace(/&nbsp;/g, ' '), 'Line 3', 'signature help does not repeat its signature');
  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at(document, 'ret i32 %value', 9));
  assert.ok(completion.items.some(item => String(typeof item.label === 'string' ? item.label : item.label.label).includes('left')));
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  assert.ok(symbols.some(symbol => symbol.name.includes('sum')));
  const semantic = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
  assert.ok(semantic && semantic.data.length > 0, 'semantic symbol tokens are published');
  const folding = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
  assert.ok(folding.length >= 2, 'both function bodies fold');
  const blocks = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: [
    'define i32 @choose(i32 %x, i32 %y) {',
    'entry:',
    '  %cmp = icmp samesign slt i32 %x, %y',
    '  br i1 %cmp, label %"less value", label %done',
    '"less value":',
    '  br label %done',
    'done:',
    '  %answer = phi i32 [ %x, %"less value" ], [ %y, %entry ]',
    '  ret i32 %answer',
    '}'
  ].join('\n') });
  const comparisonHover = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', blocks.uri, at(blocks, 'icmp', 1)));
  assert.ok(comparisonHover.includes('<result> = icmp <cond> <ty> <op1>, <op2>'));
  for (const predicate of ['eq', 'ne', 'ugt', 'uge', 'ult', 'ule', 'sgt', 'sge', 'slt', 'sle']) {
    assert.ok(comparisonHover.includes('`' + predicate + '`'), predicate + ' in icmp hover');
  }
  assert.match(comparisonHover, /samesign/);
  assert.match(comparisonHover, /poison/);
  const labelHover = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', blocks.uri, at(blocks, 'label %"less value"', 8)));
  assert.equal(labelHover.trim(), '```llvm-ir\n(label) %"less value"\n```\n\n\n---\n\nLine 5 in @choose');
  const parameterHover = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', blocks.uri, at(blocks, 'i32 %x', 5)));
  assert.equal(parameterHover.trim(), '```llvm-ir\n(parameter) %x: i32\n```\n\n\n---\n\nLine 1 in @choose');
  const blockFolds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', blocks.uri);
  for (const [start, end] of [[1, 3], [4, 5], [6, 8]]) {
    assert.ok(blockFolds.some(fold => fold.start === start && fold.end === end), 'block fold ' + start + '..' + end);
  }
  const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', blocks.uri);
  const blockTokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', blocks.uri);
  const labels = [];
  let tokenLine = 0, tokenColumn = 0;
  for (let index = 0; index < blockTokens.data.length; index += 5) {
    const [deltaLine, deltaColumn, length, kind] = blockTokens.data.slice(index, index + 4);
    tokenLine += deltaLine;
    tokenColumn = deltaLine ? deltaColumn : tokenColumn + deltaColumn;
    if (legend.tokenTypes[kind] === 'label') labels.push({
      line: tokenLine,
      text: blocks.getText(new vscode.Range(tokenLine, tokenColumn, tokenLine, tokenColumn + length))
    });
  }
  assert.equal(labels.length, 8, 'three label definitions and five references');
  assert.ok(labels.some(label => label.line === 4 && label.text === '"less value"'), 'quoted definition has label semantics');
  assert.ok(labels.some(label => label.line === 7 && label.text === '%"less value"'), 'phi predecessor has label semantics');
  assert.deepEqual(extension.packageJSON.contributes.semanticTokenScopes[0].scopes.label, ['entity.name.label.llvm']);
  const highlights = await vscode.commands.executeCommand('vscode.executeDocumentHighlights', document.uri, at(document, '%value = add', 2));
  assert.equal(highlights.length, 2, 'occurrence highlights stay in the right function');
  const entire = new vscode.Range(document.positionAt(0), document.positionAt(fixture.length));
  const hints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', document.uri, entire);
  assert.ok(hints.length >= 2, 'inferred type hints are on by default');
  const argumentNames = hints.filter(hint => hint.kind === vscode.InlayHintKind.Parameter).map(hint => typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join(''));
  assert.deepEqual(argumentNames, ['left:', 'right:'], 'call arguments are named after parameters');
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri, 10);
  const sumLens = lenses.find(lens => lens.range.start.line === 2);
  assert.equal(sumLens?.command?.title, '1 reference', 'reference CodeLens counts the call in @main');
  const branchCompletion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at(document, 'i32 %right', 4));
  assert.ok(branchCompletion.items.every(item => !String(typeof item.label === 'string' ? item.label : item.label.label).startsWith('@')), 'an i32 operand excludes pointer globals');
  const formatted = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 4, insertSpaces: true });
  assert.ok(Array.isArray(formatted));
  const originalTokens = fixture.match(/\S+/g);
  let output = fixture;
  for (const edit of [...formatted].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
    output = output.slice(0, document.offsetAt(edit.range.start)) + edit.newText + output.slice(document.offsetAt(edit.range.end));
  }
  assert.deepEqual(output.match(/\S+/g), originalTokens, 'formatter preserves tokens');
  // Coursework is not published with the extension; check it only when present.
  const objectsText = courseFile('hw2/objects.llvm');
  if (objectsText) {
  const objects = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: objectsText });
  const pointerHover = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', objects.uri, at(objects, '%main_ptr =', 2)));
  assert.match(pointerHover, /\(variable\) %main_ptr: ptr → ptr → %Class_Main\? = alloca ptr, align 8/);
  assert.match(pointerHover, /`%Class_Main\?` — `@Main` indexes the stored pointer as this type/);
  const objectHints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', objects.uri, new vscode.Range(objects.positionAt(0), objects.positionAt(objectsText.length)));
  const hintLabels = objectHints.map(hint => typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join(''));
  assert.ok(hintLabels.includes(': ptr → @dog_makeNoise?'), 'vtable load shows its likely method');
  assert.ok(hintLabels.includes(': ptr → i32'), 'GEP field address shows its member type');
  }
  const colors = extension.packageJSON.contributes.colors.map(color => color.id);
  assert.deepEqual(colors, ['llvmIR.labelForeground'], 'labels have a themeable color');
  const loopDoc = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: 'define i32 @f(i32 %n) {\nentry:\n  br label %loop\nloop:\n  %i = phi i32 [ 0, %entry ], [ %j, %loop ]\n  %j = add i32 %i, 1\n  %c = icmp slt i32 %j, %n\n  br i1 %c, label %loop, label %done\ndone:\n  ret i32 %j\n}\n' });
  const loopHints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', loopDoc.uri, new vscode.Range(0, 0, 11, 0));
  const predecessorLabels = loopHints.filter(hint => Array.isArray(hint.label)).map(hint => hint.label.map(part => part.value).join(''));
  assert.deepEqual(predecessorLabels, ['preds: %entry, %loop', 'preds: %loop'], 'blocks list their predecessors');
  assert.match(hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', loopDoc.uri, at(loopDoc, 'loop:'))), /Loop header: `%loop` branches back here/);
  await vscode.window.showTextDocument(loopDoc);
  await vscode.commands.executeCommand('llvmIR.showControlFlowGraph');
  const typo = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: 'define i32 @f(i32 %count) {\n  ret i32 %cuont\n}\n' });
  let builtIn = [];
  for (let attempt = 0; attempt < 50 && !builtIn.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    builtIn = vscode.languages.getDiagnostics(typo.uri).filter(diagnostic => diagnostic.source === 'llvm-ir');
  }
  assert.equal(builtIn[0]?.message, 'Value %cuont is not defined in @f. Did you mean %count?', 'built-in checks need no LLVM installation');
  const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', typo.uri, builtIn[0].range);
  assert.ok(fixes.some(fix => fix.title === 'Change to %count'), 'misspelled names have a quick fix');
  for (const name of ['fact1', 'fact2', 'fib', 'max']) {
    const content = courseFile('hw0/' + name + '.llvm');
    if (!content) continue;
    const course = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content });
    const outline = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', course.uri);
    assert.ok(outline.some(symbol => symbol.name.includes('main')), name + ' has main in outline');
  }
  if (spawnSync('llvm-as', ['--version']).status === 0) {
    await vscode.workspace.getConfiguration('llvmIR').update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
    const bad = await vscode.workspace.openTextDocument({ language: 'llvm-ir', content: 'define i32 @broken() {\nentry:\n ret void\n}\n' });
    await vscode.window.showTextDocument(bad);
    const verification = await vscode.commands.executeCommand('llvmIR.verify');
    assert.ok(verification && verification.issues.length > 0, 'manual compiler verification reports invalid IR');
    assert.ok(vscode.languages.getDiagnostics(bad.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error));
    await vscode.workspace.getConfiguration('llvmIR').update('diagnostics.enabled', false, vscode.ConfigurationTarget.Global);
    console.log('PASS: compiler errors surface through real VS Code diagnostics.');
  }
  console.log('PASS: real VS Code host — activation, pointer/storage hovers, definitions, scoped references/rename, signature help, completion, symbols, semantic tokens, inlay hints, argument names, reference lenses, built-in diagnostics and quick fixes, label colors, predecessor hints, block hovers, control-flow graph, folding, highlights, formatting, course files.');
  await require('./workspace-suite').run();
}
exports.run = run;
