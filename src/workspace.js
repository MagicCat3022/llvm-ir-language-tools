'use strict';

// The filesystem and index are injected: this also works with remote/virtual URIs.
function createWorkspaceService(vscode, output, index) {
  if (!index) throw new TypeError('A workspace index is required');
  const workspace = vscode.workspace || {};
  const opens = new Map(), generations = new Map(), jobs = new Set(), subscriptions = [];
  const issues = new Map(), reported = new Set();
  let started = false, disposed = false, epoch = 0, scanning = false, scanPromise = Promise.resolve();
  let readQueue = Promise.resolve();
  let mutationRevision = 0;
  const key = uri => typeof uri === 'string' ? uri : uri.toString();
  const supported = doc => doc && doc.languageId === 'llvm-ir';
  const bump = uri => { const id = key(uri); generations.set(id, (generations.get(id) || 0) + 1); mutationRevision++; };
  const folders = () => workspace.workspaceFolders || [];
  const asUri = uri => typeof uri === 'string' && vscode.Uri?.parse ? vscode.Uri.parse(uri) : uri;
  function config(uri) {
    const settings = workspace.getConfiguration?.('llvmIR', asUri(uri));
    const get = (name, fallback) => settings?.get(`workspace.${name}`, fallback) ?? fallback;
    const limit = (name, fallback, min, max) => {
      const value = Number(get(name, fallback));
      return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
    };
    return { enabled: get('enabled', true), include: get('include', '**/*.{ll,llvm}'),
      exclude: get('exclude', '**/{.git,node_modules,.vscode-test,build,dist,out}/**'),
      maxFiles: limit('maxFiles', 500, 1, 10000), maxFileBytes: limit('maxFileBytes', 2097152, 1024, 16777216),
      maxTotalBytes: limit('maxTotalBytes', 33554432, 1024, 268435456), projectRoots: get('projectRoots', []) };
  }
  function log(message) { if (!reported.has(message)) { reported.add(message); output?.appendLine?.(message); } }
  function fail(root, reason) { issues.set(root, reason); log(`Workspace indexing: ${reason}`); }
  function parts(uri) {
    try {
      const parsed = new URL(key(uri));
      if (parsed.search || parsed.hash) return undefined;
      const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments.some(s => s.includes('/') || s.includes('\\') || s === '.' || s === '..')) return undefined;
      return { origin: `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.host}`, segments };
    } catch { return undefined; }
  }
  function relative(uri, base) {
    const a = parts(uri), b = parts(base);
    if (!a || !b || a.origin !== b.origin || b.segments.some((s, i) => a.segments[i] !== s)) return undefined;
    return a.segments.slice(b.segments.length).join('/');
  }
  function folderFor(uri) {
    return folders().filter(folder => relative(uri, folder.uri) !== undefined)
      .sort((a, b) => key(b.uri).length - key(a.uri).length)[0];
  }
  function projectRoot(uri, folder, cfg) {
    const rel = relative(uri, folder.uri);
    const roots = Array.isArray(cfg.projectRoots) ? cfg.projectRoots : [];
    if (!Array.isArray(cfg.projectRoots)) log('Workspace indexing: projectRoots must be an array of relative directories.');
    let selected = '';
    for (const value of roots) {
      if (typeof value !== 'string' || !value || /[:%\\?#]/.test(value) || value.startsWith('/') || value.endsWith('/') ||
          value.split('/').some(s => !s || s === '.' || s === '..')) {
        log('Workspace indexing: ignored invalid projectRoots entry; use relative subdirectories without traversal.');
        continue;
      }
      if ((rel === value || rel.startsWith(`${value}/`)) && value.length > selected.length) selected = value;
    }
    return selected ? `${key(folder.uri).replace(/\/$/, '')}/${selected.split('/').map(encodeURIComponent).join('/')}` : key(folder.uri);
  }
  function excludes(uri, cfg) {
    const patterns = [cfg.exclude];
    for (const section of ['files', 'search']) {
      const values = workspace.getConfiguration?.(section, asUri(uri))?.get('exclude', {}) || {};
      for (const [pattern, value] of Object.entries(values)) {
        if (value === true) patterns.push(pattern);
        else if (value && typeof value === 'object') log('Workspace indexing: conditional sibling excludes are not applied; only boolean excludes are supported.');
      }
    }
    return patterns.filter(p => typeof p === 'string' && p);
  }
  function scope(uri) {
    const id = key(uri), folder = folderFor(uri), cfg = config(uri);
    if (!folder || !cfg.enabled) return { root: id, cfg, isolated: true };
    const rel = relative(uri, folder.uri);
    if (!matches(rel, cfg.include) || excludes(uri, cfg).some(pattern => matches(rel, pattern))) return { root: id, cfg, isolated: true, folder };
    return { root: projectRoot(uri, folder, cfg), cfg, isolated: false, folder };
  }
  function rootFor(uri) { return index.get(key(uri))?.root || scope(uri).root; }
  const bytes = text => Buffer.byteLength(text, 'utf8');
  function fits(uri, text, info) {
    if (info.isolated) return true;
    if (bytes(text) > info.cfg.maxFileBytes) { fail(info.root, 'A relevant file exceeds workspace.maxFileBytes.'); return false; }
    const others = index.documents().filter(doc => doc.uri !== key(uri) && !scope(doc.uri).isolated &&
      key(folderFor(doc.uri)?.uri || '') === key(info.folder.uri));
    if (others.length >= info.cfg.maxFiles) { fail(key(info.folder.uri), 'File count exceeds workspace.maxFiles.'); return false; }
    if (others.reduce((total, doc) => total + bytes(doc.text), bytes(text)) > info.cfg.maxTotalBytes) {
      fail(key(info.folder.uri), 'Source size exceeds workspace.maxTotalBytes.'); return false;
    }
    return true;
  }
  function sync(document) {
    if (disposed || !supported(document)) return;
    const id = key(document.uri);
    opens.set(id, document); bump(id);
    const text = document.getText(), info = scope(document.uri);
    const root = fits(document.uri, text, info) ? info.root : id;
    const previous = index.get(id);
    if (!previous || previous.text !== text || previous.version !== document.version || previous.root !== root)
      index.upsert(id, text, { root, version: document.version });
  }
  function valid(id, revision, scan) { return !disposed && epoch === scan && (generations.get(id) || 0) === revision && !opens.has(id); }
  function read(uri, scan = epoch, expectedRevision = generations.get(key(uri)) || 0) {
    // Serialize background I/O, including watcher bursts. Capture the revision
    // at scheduling time so an obsolete queued job cannot resurrect a file.
    const revision = expectedRevision;
    if (!generations.has(key(uri))) generations.set(key(uri), revision);
    const pending = readQueue.then(() => readNow(uri, scan, revision));
    readQueue = pending.catch(() => {});
    return pending;
  }
  async function readNow(uri, scan, revision) {
    const id = key(uri), info = scope(uri);
    if (!valid(id, revision, scan)) return;
    if (info.isolated) { index.remove(id); return; }
    if (!workspace.fs?.stat || !workspace.fs?.readFile) { fail(info.root, 'Workspace filesystem is unavailable.'); return; }
    try {
      const stat = await workspace.fs.stat(uri);
      if (!valid(id, revision, scan)) return;
      if (stat.size > info.cfg.maxFileBytes) { index.remove(id); fail(info.root, 'A relevant file exceeds workspace.maxFileBytes.'); return; }
      const data = await workspace.fs.readFile(uri);
      if (!valid(id, revision, scan)) return;
      const text = Buffer.from(data).toString('utf8');
      if (!fits(uri, text, info)) { index.remove(id); return; }
      index.upsert(id, text, { root: info.root });
    } catch {
      if (!valid(id, revision, scan)) return;
      index.remove(id); fail(info.root, 'A relevant file could not be read.');
    }
  }
  function track(promise) {
    jobs.add(promise);
    promise.then(() => jobs.delete(promise), () => jobs.delete(promise));
    return promise;
  }
  function onDisk(uri, deleted = false) {
    if (disposed) return;
    const id = key(uri), relevant = !scope(uri).isolated || opens.has(id) || index.get(id) || generations.has(id);
    if (!deleted && !relevant) return;
    if (relevant) bump(id);
    if (deleted) {
      // Providers may report a directory deletion without individual children.
      const known = new Set([...generations.keys(), ...index.documents().map(doc => doc.uri)]);
      for (const child of known) if (child !== id && relative(child, uri) !== undefined) {
        bump(child);
        if (!opens.has(child)) index.remove(child);
      }
    }
    if (opens.has(id)) return;
    if (deleted) index.remove(id);
    else track(read(uri));
  }
  function subscribe(event, callback) { if (typeof workspace[event] === 'function') subscriptions.push(workspace[event](callback)); }
  function attach() {
    subscribe('onDidOpenTextDocument', sync);
    subscribe('onDidChangeTextDocument', event => sync(event.document));
    subscribe('onDidSaveTextDocument', sync);
    subscribe('onDidCloseTextDocument', document => {
      const id = key(document.uri);
      if (opens.get(id) !== document) return;
      opens.delete(id); bump(id); index.remove(id); track(read(document.uri));
    });
    subscribe('onDidChangeWorkspaceFolders', () => { rescan(); });
    subscribe('onDidChangeConfiguration', event => {
      if (!event.affectsConfiguration || ['llvmIR.workspace', 'files.exclude', 'search.exclude'].some(name => event.affectsConfiguration(name))) rescan();
    });
    if (workspace.createFileSystemWatcher) {
      const watcher = workspace.createFileSystemWatcher('**/*');
      subscriptions.push(watcher);
      for (const [event, deleted] of [['onDidChange', false], ['onDidCreate', false], ['onDidDelete', true]]) {
        if (watcher[event]) subscriptions.push(watcher[event](uri => onDisk(uri, deleted)));
      }
    }
  }
  async function scan(scanEpoch) {
    for (const folder of folders()) {
      if (disposed || scanEpoch !== epoch) return;
      const cfg = config(folder.uri);
      if (!cfg.enabled) continue;
      if (!workspace.findFiles || !workspace.fs?.readFile || !workspace.fs?.stat) { fail(key(folder.uri), 'Workspace discovery/filesystem is unavailable.'); continue; }
      try {
        const patterns = excludes(folder.uri, cfg);
        const exclude = patterns.length > 1 ? `{${patterns.join(',')}}` : patterns[0] || null;
        const pattern = vscode.RelativePattern ? new vscode.RelativePattern(folder, cfg.include) : { baseUri: folder.uri, pattern: cfg.include };
        const discoveryRevisions = new Map(generations);
        const discovered = await workspace.findFiles(pattern, exclude, cfg.maxFiles + 1);
        if (disposed || scanEpoch !== epoch) return;
        const unique = [...new Map(discovered.map(uri => [key(uri), uri])).values()].sort((a, b) => key(a).localeCompare(key(b)));
        if (unique.length > cfg.maxFiles) fail(key(folder.uri), 'File count exceeds workspace.maxFiles.');
        for (let i = 0; i < Math.min(unique.length, cfg.maxFiles); i++) {
          if (disposed || scanEpoch !== epoch) return;
          const uri = unique[i];
          if (key(folderFor(uri)?.uri || '') !== key(folder.uri)) continue;
          await read(uri, scanEpoch, discoveryRevisions.get(key(uri)) || 0);
          if ((i + 1) % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch { if (!disposed && scanEpoch === epoch) fail(key(folder.uri), 'Workspace file discovery failed.'); }
    }
  }
  function rescan() {
    if (disposed) return Promise.resolve();
    const scanEpoch = ++epoch; scanning = true; issues.clear();
    for (const doc of index.documents()) if (!opens.has(doc.uri)) index.remove(doc.uri);
    for (const document of opens.values()) sync(document);
    scanPromise = track(scan(scanEpoch).finally(() => { if (epoch === scanEpoch) scanning = false; }));
    return scanPromise;
  }
  function start() {
    if (disposed) return Promise.resolve();
    if (!started) {
      started = true; attach();
      for (const doc of workspace.textDocuments || []) if (supported(doc)) opens.set(key(doc.uri), doc);
      return rescan();
    }
    return scanPromise;
  }
  async function ready() {
    await start();
    while (!disposed && jobs.size) await Promise.allSettled([...jobs]);
  }
  async function ensure(document) { await ready(); sync(document); }
  function status(document) {
    const info = scope(document.uri || document), snapshot = index.get(key(document.uri || document));
    const reason = issues.get(info.root) || (info.folder && issues.get(key(info.folder.uri)));
    if (disposed) return { complete: false, reason: 'Workspace index is disposed.' };
    if (info.isolated) return { complete: true };
    if (!started || scanning || jobs.size) return { complete: false, reason: 'Workspace indexing is in progress.' };
    if (reason) return { complete: false, reason };
    if (snapshot && snapshot.root !== info.root) return { complete: false, reason: 'Document is isolated by workspace limits.' };
    return { complete: true };
  }
  async function validateEdits(edits) {
    if (disposed || !Array.isArray(edits)) return false;
    const scanEpoch = epoch, planRevision = mutationRevision, allSnapshots = index.documents();
    const snapshots = [...new Set(edits.map(edit => edit.uri))].map(uri => ({ uri, snapshot: index.get(uri), revision: generations.get(uri) || 0, document: opens.get(uri) }));
    // A definition/reference introduced in a non-edited module can invalidate
    // the rename plan too, so guard the entire index, not just target files.
    const unchanged = () => !disposed && epoch === scanEpoch && mutationRevision === planRevision &&
      index.documents().length === allSnapshots.length && allSnapshots.every(snapshot => index.get(snapshot.uri) === snapshot) && snapshots.every(item =>
      index.get(item.uri) === item.snapshot && (generations.get(item.uri) || 0) === item.revision && opens.get(item.uri) === item.document);
    for (const item of snapshots) {
      if (!item.snapshot) return false;
      if (item.document) {
        if (item.document.version !== item.snapshot.version || item.document.getText() !== item.snapshot.text) return false;
      } else {
        if (!workspace.fs?.stat || !workspace.fs?.readFile) return false;
        try {
          const uri = vscode.Uri?.parse ? vscode.Uri.parse(item.uri) : item.uri;
          const stat = await workspace.fs.stat(uri);
          if (!unchanged() || stat.size > config(uri).maxFileBytes) return false;
          const data = await workspace.fs.readFile(uri);
          if (!unchanged() || Buffer.from(data).toString('utf8') !== item.snapshot.text) return false;
        } catch { return false; }
      }
    }
    return unchanged() && snapshots.every(item => !item.document ||
      (item.document.version === item.snapshot.version && item.document.getText() === item.snapshot.text));
  }
  function dispose() {
    if (disposed) return;
    disposed = true; epoch++;
    for (const subscription of subscriptions) subscription?.dispose?.();
    opens.clear(); index.clear();
  }
  return { index, start, ready, ensure, sync, rootFor, status, validateEdits, rescan, dispose };
}

// VS Code-style common glob forms, including nested brace alternatives. The
// authoritative discovery uses findFiles; this guard also isolates open files.
function matches(path, pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  function compile(glob) {
    let result = '', braces = 0;
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; }
        else result += '[^/]*';
      } else if (c === '?') result += '[^/]';
      else if (c === '{') { braces++; result += '(?:'; }
      else if (c === '}') { braces--; result += ')'; }
      else if (c === ',') result += braces > 0 ? '|' : ',';
      else if (c === '[') {
        const end = glob.indexOf(']', i + 1);
        if (end < 0) result += '\\[';
        else { result += glob.slice(i, end + 1).replace(/^\[!/, '[^'); i = end; }
      } else result += /[\\^$+.()|]/.test(c) ? `\\${c}` : c;
    }
    return result;
  }
  try { return new RegExp(`^${compile(pattern)}$`).test(path); } catch { return false; }
}

module.exports = { createWorkspaceService };
