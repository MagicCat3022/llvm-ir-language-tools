'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

function at(doc, needle, delta = 1) {
  const offset = doc.getText().indexOf(needle);
  assert.notEqual(offset, -1, needle);
  return doc.positionAt(offset + delta);
}
function text(hovers) {
  return hovers.flatMap(h => h.contents).map(value => value.value || value).join('\n').replace(/&nbsp;/g, ' ');
}
function label(item) { return typeof item.label === 'string' ? item.label : item.label.label; }

async function run() {
  const folder = vscode.workspace.workspaceFolders.find(folder => folder.name === 'LLVM project A');
  assert.ok(folder, 'isolated multi-root fixture loaded');
  const entryUri = vscode.Uri.joinPath(folder.uri, 'entry.ll');
  const implUri = vscode.Uri.joinPath(folder.uri, 'impl.llvm');
  const doc = await vscode.workspace.openTextDocument(entryUri);
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('llvmIR.reindex');
  const definition = async () => vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, at(doc, '@twice(i32 21)'));
  let targets = await definition();
  assert.equal(targets.length, 1, 'local declaration resolves to one implementation in this root');
  assert.equal(targets[0].uri.toString(), implUri.toString(), 'unopened .llvm is indexed, other root excluded');
  const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, at(doc, '@twice(i32 21)'));
  assert.ok(refs.some(ref => ref.uri.toString() === implUri.toString()));
  assert.ok(refs.some(ref => ref.uri.toString() === entryUri.toString()));
  assert.ok(refs.every(ref => ref.uri.toString().startsWith(folder.uri.toString() + '/')));
  const privateRefs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, at(doc, '@helper()'));
  assert.ok(privateRefs.every(ref => ref.uri.toString() === entryUri.toString()), 'internal same-name symbols stay distinct');
  const renamed = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, at(doc, '@twice(i32 21)'), 'double_it');
  assert.deepEqual(renamed.entries().map(([uri]) => uri.toString()).sort(), [entryUri.toString(), implUri.toString()].sort());
  assert.ok(renamed.entries().flatMap(([, edits]) => edits).every(edit => edit.newText === '@double_it'));
  await assert.rejects(
    vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', doc.uri, at(doc, '@twice(i32 21)'), 'taken'),
    /collision|exists|conflict/i
  );
  const items = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, at(doc, '@twice(i32 21)', 1));
  const remote = items.items.find(item => label(item) === '@remote_only');
  assert.ok(remote, 'undeclared workspace function suggested');
  // Its signature has no named types, so completion also adds the declaration.
  assert.match(remote.detail, /adds declaration/i);
  assert.equal(remote.additionalTextEdits?.length, 1, 'completion adds one declaration');
  assert.match(remote.additionalTextEdits[0].newText, /^\s*declare void @remote_only\(\)\s*$/);
  assert.ok(!items.items.some(item => label(item) === '@excluded_function'));
  const hover = text(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, at(doc, '@twice(i32 21)')));
  assert.match(hover, /impl\.llvm/);
  const printf = text(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, at(doc, '@printf(ptr null')));
  assert.match(printf, /format|formatted/i);
  assert.match(printf, /return/i);
  assert.match(printf, /%d/);
  const intrinsic = text(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, at(doc, '@llvm.assume(i1 true')));
  assert.match(intrinsic, /assum|optimizer/i);
  const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'twice');
  assert.ok(symbols.some(symbol => symbol.location.uri.toString() === implUri.toString()));
  assert.ok(symbols.some(symbol => symbol.location.uri.fsPath.includes(path.sep + 'project-b' + path.sep)));
  const implementation = await vscode.workspace.openTextDocument(implUri);
  const change = new vscode.WorkspaceEdit();
  change.insert(implUri, new vscode.Position(0, 0), '; unsaved overlay\n');
  assert.ok(await vscode.workspace.applyEdit(change));
  targets = await definition();
  assert.equal(targets[0].range.start.line, 1, 'dirty buffer position overrides saved disk');
  assert.ok(implementation.isDirty);
  console.log('PASS: multi-root workspace — unopened .llvm definitions, cross-file refs/rename, collision refusal, private isolation, excludes, declaration-aware completion, library/intrinsic hovers, workspace symbols, dirty overlays.');
}
exports.run = run;
