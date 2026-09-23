'use strict';

const analysis = require('./analysis');
const { canonicalName } = require('./symbol-names');
const { lookupLibrary, libraryParameters } = require('./library');

// Keep VS Code objects at the boundary; the index stores immutable text snapshots.
function attachWorkspaceProviders(vscode, providers, workspace, { markdown, paragraph, symbolDocumentation, signatureLabel }) {
  const index = workspace.index;
  const originals = {
    hover: providers.hover.provideHover.bind(providers.hover),
    completion: providers.completion.provideCompletionItems.bind(providers.completion),
    signatures: providers.signatures.provideSignatureHelp.bind(providers.signatures),
    rename: providers.rename.provideRenameEdits.bind(providers.rename)
  };
  const settings = document => vscode.workspace.getConfiguration('llvmIR', document.uri);
  const key = document => document.uri.toString();
  const views = new WeakMap();
  function view(uri) {
    const snapshot = index.get(uri);
    if (!snapshot) return undefined;
    if (views.has(snapshot)) return views.get(snapshot);
    const starts = [0];
    for (let i = 0; i < snapshot.text.length; i++) {
      if (snapshot.text[i] === '\r') { if (snapshot.text[i + 1] === '\n') i++; starts.push(i + 1); }
      else if (snapshot.text[i] === '\n') starts.push(i + 1);
    }
    const result = { uri: vscode.Uri.parse(uri), positionAt(offset) {
      offset = Math.max(0, Math.min(offset, snapshot.text.length));
      let low = 0, high = starts.length;
      while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid; else high = mid; }
      return new vscode.Position(low, offset - starts[low]);
    } };
    views.set(snapshot, result);
    return result;
  }
  const range = (doc, span) => new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
  const location = target => new vscode.Location(vscode.Uri.parse(target.uri), range(view(target.uri), target));
  const kind = symbol => ({ function: vscode.SymbolKind.Function, global: vscode.SymbolKind.Variable, type: vscode.SymbolKind.Struct })[symbol.kind] || vscode.SymbolKind.Variable;
  const declaration = symbol => symbol.kind === 'function' ? symbol.declaration :
    /=\s*(?:external|extern_weak)\b/.test(symbol.definition || '');
  function source(target) {
    const uri = vscode.Uri.parse(target.uri);
    const path = vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(uri, true) : (uri.path || target.uri);
    return `${path}:${view(target.uri).positionAt(target.start).line + 1}`;
  }
  async function ensure(document, token, localPosition) {
    const version = document.version;
    if (localPosition && workspace.sync) {
      workspace.sync(document);
      const target = at(document, localPosition);
      // Local editing must not wait for hundreds of remote filesystem reads.
      if (target.token && !(target.token.kind === 'identifier' && target.token.text.startsWith('@')))
        return !token?.isCancellationRequested && !document.isClosed;
    }
    await workspace.ensure(document);
    return !token?.isCancellationRequested && !document.isClosed && document.version === version;
  }
  function at(document, position) {
    const parsed = index.get(key(document))?.analysis;
    if (!parsed) return {};
    const offset = document.offsetAt(position), token = analysis.tokenAt(parsed, offset);
    const symbol = analysis.symbolAt(parsed, offset);
    const blocked = token?.kind === 'comment' || token?.kind === 'string' && symbol?.kind !== 'label';
    return { parsed, offset, token, symbol, blocked };
  }
  function library(document, name, symbol, offset) {
    if (!settings(document).get('libraryHelp.enabled', true)) return undefined;
    const entry = lookupLibrary(name, symbol);
    if (!entry) return undefined;
    if (entry.category === 'libc' && index.definitions(key(document), offset).some(target =>
      target.symbol.kind === 'function' && !target.symbol.declaration)) return undefined;
    return entry;
  }
  function describe(result, entry, full = true) {
    // Hovers place documentation below the signature rule; completion and signature help stay compact.
    const next = () => full ? paragraph(result) : result.appendMarkdown('\n\n');
    next().appendText(entry.summary);
    if (full) {
      for (const parameter of entry.parameters) next().appendMarkdown(`_@param_ \`${parameter.name}\` — `).appendText(parameter.description);
      next().appendMarkdown('_@returns_ ').appendText(entry.returns);
      for (const note of entry.notes) next().appendText(note);
      if (entry.details) next().appendMarkdown(entry.details);
    }
    next().appendMarkdown(`[${entry.category === 'libc' ? 'C library reference' : 'LLVM intrinsic reference'}](${entry.url})`);
    return result;
  }
  providers.definition.provideDefinition = async (document, position, token) => {
    if (!await ensure(document, token, position)) return undefined;
    const target = at(document, position);
    return target.blocked ? undefined : index.definitions(key(document), target.offset).map(location);
  };
  providers.references.provideReferences = async (document, position, context, token) => {
    if (!await ensure(document, token, position)) return [];
    const target = at(document, position);
    return target.blocked ? [] : index.references(key(document), target.offset, context.includeDeclaration).map(location);
  };
  providers.hover.provideHover = async (document, position, cancellation) => {
    if (!await ensure(document, cancellation, position)) return undefined;
    const { token, symbol, offset, blocked } = at(document, position);
    if (blocked || !token) return undefined;
    const original = originals.hover(document, position);
    if (token.kind !== 'identifier' || !token.text.startsWith('@')) return original;
    const targets = index.definitions(key(document), offset);
    const external = targets.filter(target => target.uri !== key(document));
    const entry = library(document, token.text, symbol, offset);
    if (!entry && !external.length) return original;
    // VS Code normalizes Hover.contents to an array; mocks may retain a single item.
    const content = original ? (Array.isArray(original.contents) ? original.contents[0] : original.contents)
      : targets.length === 1 ? symbolDocumentation(targets[0].symbol, view(targets[0].uri)) : markdown().appendCodeblock(`${entry ? '(function) ' : ''}${token.text}`, 'llvm-ir');
    if (entry) describe(content, entry);
    if (!symbol) paragraph(content).appendText('Declaration required in this module.');
    if (external.length) {
      const allDeclarations = external.every(target => declaration(target.symbol));
      paragraph(content).appendText(external.length === 1 ? `${allDeclarations ? 'Declaration' : 'Definition'}: ` + source(external[0]) : `${external.length} candidate ${allDeclarations ? 'declarations' : 'definitions'} (link selection is unknown):`);
      if (external.length > 1) for (const target of external.slice(0, 8)) paragraph(content).appendText(source(target));
      if (external.length > 8) paragraph(content).appendText('More candidates: use Go to Definition.');
    }
    const status = workspace.status(document);
    if (!status.complete && external.length) paragraph(content).appendText('Workspace index is incomplete; more candidates may exist.');
    return new vscode.Hover(content, range(document, token));
  };
  providers.completion.provideCompletionItems = async (document, position, cancellation) => {
    if (!await ensure(document, cancellation)) return [];
    const items = originals.completion(document, position);
    const { parsed, offset, blocked } = at(document, position);
    const previous = parsed && analysis.tokenAt(parsed, Math.max(0, offset - 1));
    if (!parsed || blocked || previous?.kind === 'comment' || previous?.kind === 'string') return items;
    // Only offer external names in an @ prefix, not at every instruction/local slot.
    const current = analysis.tokenAt(parsed, offset);
    const prefix = current?.start < offset ? current : previous;
    for (const item of items) {
      const symbol = parsed.symbols.find(symbol => symbol.name === item.label && symbol.scope === null);
      if (!symbol) continue;
      const entry = library(document, symbol.name, symbol, symbol.start);
      if (entry) item.documentation = describe(item.documentation || markdown(), entry, false);
    }
    if (!prefix || prefix.end < offset || !prefix.text.startsWith('@')) return items;
    // Globals are pointers: skip them where a label, predicate, or non-pointer value belongs.
    const context = analysis.completionContext(parsed, offset, prefix.start);
    if (context && (context.kind !== 'value' || context.expectedType && !/^ptr\b/.test(context.expectedType))) return items;
    const seen = new Set(items.filter(item => typeof item.label === 'string').map(item => canonicalName(item.label)));
    for (const target of index.completions(key(document), offset)) {
      const identity = canonicalName(target.symbol.name);
      if (seen.has(identity) || context?.callee && target.symbol.kind !== 'function') continue;
      seen.add(identity);
      const item = new vscode.CompletionItem(target.symbol.name, target.symbol.kind === 'function' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable);
      item.insertText = context?.typed ? `${context.expectedType} ${target.symbol.name}` : target.symbol.name;
      if (context?.typed) item.filterText = target.symbol.name;
      item.range = range(document, { start: prefix.start, end: prefix.end });
      const type = target.symbol.kind === 'function' ? signatureLabel(target.symbol) : target.symbol.type;
      const text = index.declaration(key(document), target.symbol.name);
      if (text) {
        // Like an auto-import: the declaration every workspace definition agrees on.
        item.additionalTextEdits = [declarationEdit(document, parsed, target.symbol.kind, text)];
        item.detail = `${type} · adds declaration · ${source(target)}`;
        item.documentation = markdown().appendMarkdown('Adds to this module:').appendCodeblock(text, 'llvm-ir');
      } else {
        item.detail = `${type} · declaration required · ${source(target)}`;
        item.documentation = markdown().appendText('Workspace candidate. Its declaration could not be derived (named types, aliases, or definitions that disagree), so only the name is inserted.');
      }
      items.push(item);
    }
    return items;
  };
  // Undefined globals that a workspace file defines: offer its declaration.
  const actions = providers.codeActions.provideCodeActions.bind(providers.codeActions);
  providers.codeActions.provideCodeActions = (document, requested, context) => {
    const result = actions(document, requested, context);
    workspace.sync?.(document);
    const parsed = index.get(key(document))?.analysis;
    if (!parsed || parsed.text !== document.getText()) return result;
    const from = document.offsetAt(requested.start), to = document.offsetAt(requested.end), offered = new Set();
    for (const token of parsed.tokens) {
      if (token.end < from || token.start > to || token.kind !== 'identifier' || token.text[0] !== '@' || analysis.symbolAt(parsed, token.start)) continue;
      const text = index.declaration(key(document), token.text), target = index.definitions(key(document), token.start)[0];
      if (!text || offered.has(canonicalName(token.text))) continue;
      offered.add(canonicalName(token.text));
      const action = new vscode.CodeAction(`Add declaration of ${token.text}${target ? ` from ${source(target)}` : ''}`, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      const edit = declarationEdit(document, parsed, target?.symbol.kind || 'function', text);
      action.edit.insert(document.uri, edit.range.start, edit.newText);
      action.diagnostics = (context?.diagnostics || []).filter(diagnostic => diagnostic.code === 'undefined-value' && diagnostic.range.start.line === document.positionAt(token.start).line);
      action.isPreferred = true;
      result.push(action);
    }
    return result;
  };
  // New declarations join the existing ones of their kind, else precede the first definition.
  function declarationEdit(document, parsed, kind, text) {
    const peers = parsed.symbols.filter(symbol => symbol.scope === null && (kind === 'function' ? symbol.kind === 'function' && symbol.declaration : symbol.kind === 'global'));
    const first = parsed.functions.find(fn => !fn.symbol.declaration);
    const insert = (offset, value) => vscode.TextEdit.insert(document.positionAt(offset), value);
    if (peers.length) return insert(Math.max(...peers.map(symbol => symbol.fullEnd)), '\n' + text);
    if (first) return insert(first.start, text + '\n\n');
    return insert(parsed.text.length, (/(?:^|\n)$/.test(parsed.text) ? '' : '\n') + text + '\n');
  }
  providers.signatures.provideSignatureHelp = async (document, position, cancellation) => {
    if (!await ensure(document, cancellation)) return undefined;
    const help = originals.signatures(document, position);
    const { parsed, offset } = at(document, position);
    const call = parsed && analysis.callAt(parsed, offset);
    if (!help || !call) return help;
    const entry = library(document, call.symbol.name, call.symbol, call.symbol.start);
    if (entry) {
      describe(help.signatures[0].documentation, entry, false);
      const parameters = libraryParameters(entry, call.symbol);
      help.signatures[0].parameters.forEach((parameter, i) => {
        if (parameters[i]) parameter.documentation = markdown().appendText(parameters[i].description);
      });
    }
    return help;
  };
  providers.rename.provideRenameEdits = async (document, position, newName, cancellation) => {
    if (!await ensure(document, cancellation, position)) throw new Error('Document changed or rename was cancelled. Try again.');
    const { symbol, offset, blocked } = at(document, position);
    if (blocked) throw new Error('No LLVM symbol at this position.');
    const plan = index.rename(key(document), offset, newName);
    if (!plan) return originals.rename(document, position, newName);
    if (plan.error) throw new Error(plan.error);
    const local = symbol && /^(?:define\s+)?(?:private|internal)\b/.test(symbol.definition?.replace(/^@(?:"(?:[^"\\]|\\.)*"|[^\s]+)\s*=\s*/, '') || '');
    if (!local && workspace.rootFor?.(document.uri) === key(document)) throw new Error('External rename requires an included workspace file with indexing enabled; isolated documents cannot establish cross-file references.');
    const status = workspace.status(document);
    if (!local && !status.complete) throw new Error('Cross-file rename requires a complete workspace index. ' + (status.reason || 'Reindex the workspace.'));
    if (!await workspace.validateEdits(plan.edits) || cancellation?.isCancellationRequested) throw new Error('Workspace files changed during rename. No edits were returned; retry after indexing finishes.');
    const edits = new vscode.WorkspaceEdit();
    for (const edit of plan.edits) edits.replace(vscode.Uri.parse(edit.uri), range(view(edit.uri), edit), edit.newText);
    return edits;
  };
  providers.workspaceSymbols = { async provideWorkspaceSymbols(query, cancellation) {
    await workspace.ready();
    if (cancellation?.isCancellationRequested) return [];
    return index.search(query).map(target => new vscode.SymbolInformation(target.symbol.name, kind(target.symbol), source(target), location(target)));
  } };
  return providers;
}

module.exports = { attachWorkspaceProviders };
