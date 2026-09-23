'use strict';

const { probeLLVMAs, producerVersion } = require('./diagnostics');

// Why llvm-as could not verify, in words a setup problem can be fixed from.
const reasons = {
  missing: 'llvm-as was not found. Install LLVM or set llvmIR.llvmAsPath',
  'not-executable': 'llvm-as cannot be executed. Check llvmIR.llvmAsPath and its permissions',
  timeout: 'llvm-as timed out. Raise llvmIR.diagnostics.timeout for large files',
  'output-limit': 'llvm-as produced too much output',
  crashed: 'llvm-as crashed',
  untrusted: 'LLVM verification requires a trusted workspace',
  disabled: 'LLVM verification is disabled (llvmIR.diagnostics.enabled)',
};
const unavailableSummary = result => reasons[result?.reason] || 'llvm-as could not verify the IR';

// A module written by a newer LLVM than the verifier often fails on syntax the
// older one lacks (for example `ptr` before LLVM 15), not on real mistakes.
function versionMismatch(text, version) {
  const producer = producerVersion(text);
  return version && producer && producer > version.major ? { producer, verifier: version.major } : undefined;
}
const mismatchNote = mismatch => `This module was produced by LLVM ${mismatch.producer}, but llvm-as is LLVM ${mismatch.verifier}; errors may come from newer syntax. Set llvmIR.llvmAsPath to a matching llvm-as.`;

// Language status items for LLVM IR editors: which llvm-as verifies and whether
// it works, and whether the workspace index is complete.
function createStatus(vscode, { workspace, output, probe = probeLLVMAs }) {
  const selector = { language: 'llvm-ir' };
  const settings = uri => vscode.workspace.getConfiguration('llvmIR', uri);
  const toolchain = vscode.languages.createLanguageStatusItem('llvmIR.toolchain', selector);
  const indexing = vscode.languages.createLanguageStatusItem('llvmIR.index', selector);
  toolchain.name = 'LLVM toolchain';
  indexing.name = 'LLVM IR workspace index';
  toolchain.command = { title: 'Check', command: 'llvmIR.checkToolchain' };
  const probes = new Map();
  let failure, mismatch, disposed = false, timer;

  const activeUri = () => {
    const document = vscode.window.activeTextEditor?.document;
    return document?.languageId === 'llvm-ir' ? document.uri : undefined;
  };
  const executableFor = uri => settings(uri).get('llvmAsPath', 'llvm-as') || 'llvm-as';
  function probeFor(uri, force = false) {
    const executable = executableFor(uri);
    if (force || !probes.has(executable)) {
      const pending = { executable, result: undefined };
      probes.set(executable, pending);
      pending.done = probe(executable, { timeoutMs: settings(uri).get('diagnostics.timeout', 5000) })
        .catch(() => ({ unavailable: `Cannot run ${executable}.`, reason: 'failed' }))
        .then(result => {
          pending.result = result;
          if (probes.get(executable) === pending) {
            output.appendLine(result.version ? `Using ${executable}: LLVM ${result.version.text}.` : `Toolchain check: ${unavailableSummary(result)}.`);
            render();
          }
          return result;
        });
    }
    return probes.get(executable);
  }
  const version = uri => probes.get(executableFor(uri))?.result?.version;

  function renderToolchain(uri) {
    toolchain.busy = false;
    if (!vscode.workspace.isTrusted) Object.assign(toolchain, { text: '$(shield) llvm-as', detail: reasons.untrusted, severity: vscode.LanguageStatusSeverity.Warning });
    // Items show only beside LLVM IR editors; nothing needs probing without one.
    else if (!uri) Object.assign(toolchain, { text: 'llvm-as', detail: 'Open an LLVM IR file to check llvm-as', severity: vscode.LanguageStatusSeverity.Information });
    else if (!settings(uri).get('diagnostics.enabled', true)) Object.assign(toolchain, { text: 'llvm-as off', detail: reasons.disabled, severity: vscode.LanguageStatusSeverity.Information });
    else {
      const probed = probeFor(uri), result = probed.result;
      if (!result) Object.assign(toolchain, { text: 'llvm-as', detail: `Checking ${probed.executable}…`, severity: vscode.LanguageStatusSeverity.Information, busy: true });
      else if (result.unavailable) Object.assign(toolchain, { text: '$(error) llvm-as', detail: `${unavailableSummary(result)}. Built-in checks still run.`, severity: vscode.LanguageStatusSeverity.Error });
      else if (failure) Object.assign(toolchain, { text: `$(warning) LLVM ${result.version.text}`, detail: `Last verification: ${unavailableSummary(failure)}.`, severity: vscode.LanguageStatusSeverity.Warning });
      else if (mismatch) Object.assign(toolchain, { text: `$(warning) LLVM ${result.version.text}`, detail: mismatchNote(mismatch), severity: vscode.LanguageStatusSeverity.Warning });
      else Object.assign(toolchain, { text: `LLVM ${result.version.text}`, detail: `Verifying with ${probed.executable}`, severity: vscode.LanguageStatusSeverity.Information });
    }
  }
  function renderIndex(uri) {
    const count = workspace.index.documents().length, files = `${count} file${count === 1 ? '' : 's'}`;
    if (!settings(uri).get('workspace.enabled', true)) {
      Object.assign(indexing, { text: 'Index off', detail: 'Cross-file features are disabled (llvmIR.workspace.enabled)', severity: vscode.LanguageStatusSeverity.Information, busy: false, command: undefined });
      return;
    }
    const state = uri ? workspace.status(uri) : { complete: true };
    const pending = !state.complete && /in progress/.test(state.reason || '');
    if (pending) {
      Object.assign(indexing, { text: `Indexing ${files}`, detail: state.reason, severity: vscode.LanguageStatusSeverity.Information, busy: true, command: undefined });
      // Settles once outstanding reads finish.
      void workspace.ready().then(() => schedule(), () => {});
    } else if (!state.complete) {
      Object.assign(indexing, { text: `$(warning) Index incomplete`, detail: `${state.reason} Cross-file rename is unavailable; ${files} indexed.`, severity: vscode.LanguageStatusSeverity.Warning, busy: false,
        command: { title: 'Reindex', command: 'llvmIR.reindex' } });
    } else {
      Object.assign(indexing, { text: `Indexed ${files}`, detail: 'Workspace index is complete', severity: vscode.LanguageStatusSeverity.Information, busy: false,
        command: { title: 'Reindex', command: 'llvmIR.reindex' } });
    }
  }
  function render() {
    if (disposed) return;
    const uri = activeUri();
    renderToolchain(uri);
    renderIndex(uri);
  }
  function schedule() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(render, 200);
  }
  const subscriptions = [toolchain, indexing,
    workspace.index.onDidChange(() => schedule()),
    // A version mismatch is a property of one module.
    vscode.window.onDidChangeActiveTextEditor(() => { mismatch = undefined; render(); }),
  ];

  return {
    render, schedule,
    // Forget cached probes, e.g. after llvmIR.llvmAsPath changes.
    reset() { probes.clear(); failure = undefined; mismatch = undefined; render(); },
    // Every llvm-as run updates the indicator: failures by reason, successes
    // and positioned errors clear them, and errors note a version mismatch.
    report(result, text, uri) {
      if (disposed || result.cancelled) return;
      if (result.unavailable) {
        failure = result;
        // A missing or unusable executable invalidates the cached probe.
        if (['missing', 'not-executable'].includes(result.reason) && version(uri)) probeFor(uri, true);
      } else {
        failure = undefined;
        const found = result.issues.some(issue => issue.severity !== 'warning') && versionMismatch(text, version(uri));
        if (found) output.appendLine(`${uri ? `${vscode.workspace.asRelativePath?.(uri) ?? uri}: ` : ''}${mismatchNote(found)}`);
        if (!uri || uri.toString() === activeUri()?.toString()) mismatch = found || undefined;
      }
      render();
    },
    // Re-run `llvm-as --version`, e.g. after changing llvmIR.llvmAsPath.
    async check() {
      const uri = activeUri();
      failure = undefined; mismatch = undefined;
      if (!vscode.workspace.isTrusted) { render(); return { unavailable: reasons.untrusted, reason: 'untrusted' }; }
      const probed = probeFor(uri, true);
      render();
      const result = await probed.done;
      output.show?.(true);
      return result;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

module.exports = { createStatus, unavailableSummary, versionMismatch };
