'use strict';

const { checkIR } = require('./checks');

// Offset → Position over a text snapshot, for files that are not open.
function positionsIn(vscode, text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue;
    if (text[i] === '\n' || text[i] === '\r') starts.push(i + 1);
  }
  return offset => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle - 1; }
    return new vscode.Position(low, offset - starts[low]);
  };
}

// Publishes built-in checks: for open documents as they are edited, and, with
// `diagnostics.scope: workspace`, for every indexed file. Errors on a line where
// llvm-as already reported one are dropped, so one mistake is reported once.
function createCheckManager(vscode, { collection, analyze, index, delay = 300 }) {
  const timers = new Map(), results = new Map(), compilerLines = new Map(), open = new Map();
  const key = uri => uri.toString();
  let disposed = false;
  const settings = uri => vscode.workspace.getConfiguration('llvmIR', uri);
  const enabled = uri => settings(uri).get('diagnostics.builtIn', true);
  const workspaceScope = uri => settings(uri).get('diagnostics.scope', 'openFiles') === 'workspace';
  const severities = { error: 'Error', warning: 'Warning', hint: 'Hint', information: 'Information' };

  function publish(uri) {
    const id = key(uri), result = results.get(id);
    if (!result) return collection.delete(uri);
    const lines = compilerLines.get(id);
    const range = span => new vscode.Range(result.positionAt(span.start), result.positionAt(span.end));
    collection.set(uri, result.issues.filter(issue => !(issue.severity === 'error' && lines?.has(result.positionAt(issue.start).line))).map(issue => {
      const diagnostic = new vscode.Diagnostic(range(issue), issue.message, vscode.DiagnosticSeverity[severities[issue.severity]]);
      diagnostic.source = 'llvm-ir';
      diagnostic.code = issue.code;
      if (issue.unnecessary) diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
      if (issue.related) diagnostic.relatedInformation = issue.related.map(related => new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, range(related)), related.message));
      return diagnostic;
    }));
  }
  function run(uri, analysis, version, positionAt) {
    const id = key(uri);
    if (disposed) return;
    if (!enabled(uri)) { results.delete(id); collection.delete(uri); return; }
    results.set(id, { version, issues: checkIR(analysis), positionAt });
    publish(uri);
  }
  function later(id, callback) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); callback(); }, delay));
  }
  // Unopened workspace files are checked from their index snapshot.
  function snapshot(id) {
    const entry = index?.get(id);
    const uri = vscode.Uri.parse(id);
    if (open.has(id)) return;
    if (!entry || !workspaceScope(uri)) { results.delete(id); compilerLines.delete(id); collection.delete(uri); return; }
    run(uri, entry.analysis, entry.version, positionsIn(vscode, entry.text));
  }
  const listener = index?.onDidChange?.(id => {
    if (disposed || open.has(id)) return;
    // A changed file invalidates its workspace llvm-as results too.
    compilerLines.delete(id);
    later(id, () => snapshot(id));
  });

  return {
    schedule(document, immediate = false) {
      if (disposed || document.languageId !== 'llvm-ir') return;
      const id = key(document.uri);
      open.set(id, document);
      const go = () => { if (!document.isClosed) run(document.uri, analyze(document), document.version, offset => document.positionAt(offset)); };
      if (immediate) { clearTimeout(timers.get(id)); go(); } else later(id, go);
    },
    close(document) {
      const id = key(document.uri);
      open.delete(id); clearTimeout(timers.get(id)); timers.delete(id);
      results.delete(id); compilerLines.delete(id); collection.delete(document.uri);
      if (index?.get(id)) later(id, () => snapshot(id));
    },
    // Lines where llvm-as reported an error for this document's current text.
    setCompilerIssues(uri, lines) {
      const id = key(uri);
      if (lines?.size) compilerLines.set(id, lines); else compilerLines.delete(id);
      if (results.has(id)) publish(uri);
    },
    refresh() {
      for (const document of open.values()) this.schedule(document, true);
      for (const entry of index?.documents() || []) snapshot(entry.uri);
      for (const id of [...results.keys()]) if (!open.has(id) && !index?.get(id)) { results.delete(id); collection.delete(vscode.Uri.parse(id)); }
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); results.clear(); open.clear();
      listener?.dispose();
      collection.clear();
    }
  };
}

module.exports = { createCheckManager, positionsIn };
