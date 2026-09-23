'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceService } = require('../src/workspace');

const uri = value => ({ toString: () => value });
const id = value => typeof value === 'string' ? value : value.toString();
const pause = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(files = { 'file:///work/a.ll': 'declare void @a()' }, settings = {}) {
  const disk = new Map(Object.entries(files)), events = {}, watcherEvents = {}, logs = [], indexed = new Map();
  const hooks = {};
  const on = (target, name) => callback => { target[name] = callback; return { dispose() { delete target[name]; } }; };
  const index = { upsert(uri, text, options) { const doc = { uri, text, ...options }; indexed.set(uri, doc); return doc; },
    get: uri => indexed.get(uri), documents: () => [...indexed.values()], remove: uri => indexed.delete(uri), clear: () => indexed.clear() };
  const workspace = {
    workspaceFolders: [{ uri: uri('file:///work') }], textDocuments: [],
    getConfiguration(section) { return { get(name, fallback) { return settings[`${section}.${name}`] ?? fallback; } }; },
    async findFiles(pattern, exclude, max) { hooks.lastFind = { pattern, exclude, max }; if (hooks.find) await hooks.find(); return [...disk.keys()].map(uri).slice(0, max); },
    fs: {
      async stat(value) { if (hooks.stat) await hooks.stat(id(value)); if (!disk.has(id(value))) throw Error('missing'); return { size: Buffer.byteLength(disk.get(id(value))) }; },
      async readFile(value) { if (hooks.read) await hooks.read(id(value)); if (!disk.has(id(value))) throw Error('missing'); return Buffer.from(disk.get(id(value))); }
    },
    createFileSystemWatcher() { return { onDidCreate: on(watcherEvents, 'create'), onDidChange: on(watcherEvents, 'change'), onDidDelete: on(watcherEvents, 'delete'), dispose() {} }; }
  };
  for (const name of ['onDidOpenTextDocument', 'onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidCloseTextDocument', 'onDidChangeWorkspaceFolders', 'onDidChangeConfiguration']) workspace[name] = on(events, name);
  const vscode = { workspace, Uri: { parse: uri }, RelativePattern: class { constructor(folder, pattern) { this.baseUri = folder.uri; this.pattern = pattern; } } };
  const service = createWorkspaceService(vscode, { appendLine: message => logs.push(message) }, index);
  const document = (path, text) => ({ uri: uri(path), languageId: 'llvm-ir', version: 1, getText() { return text; }, change(value) { text = value; this.version++; events.onDidChangeTextDocument({ document: this }); } });
  const open = doc => { workspace.textDocuments.push(doc); events.onDidOpenTextDocument(doc); };
  const close = doc => { workspace.textDocuments = workspace.textDocuments.filter(value => value !== doc); events.onDidCloseTextDocument(doc); };
  return { service, index, disk, events, watcherEvents, hooks, settings, logs, workspace, document, open, close };
}

test('discovers sorted module snapshots, starts once, overlays buffers, tracks file events', async () => {
  const f = fixture({ 'file:///work/b.llvm': 'b', 'file:///work/a.ll': 'a' });
  await f.service.start(); await f.service.start();
  assert.deepEqual(f.index.documents().map(doc => doc.uri), ['file:///work/a.ll', 'file:///work/b.llvm']);
  assert.equal(f.hooks.lastFind.max, 501);
  const doc = f.document('file:///work/a.ll', 'buffer'); f.open(doc);
  const old = f.index.get(id(doc.uri)); doc.change('edited');
  assert.equal(old.text, 'buffer'); assert.equal(f.index.get(id(doc.uri)).text, 'edited');
  f.disk.set(id(doc.uri), 'disk change'); f.watcherEvents.change(doc.uri); await f.service.ready();
  assert.equal(f.index.get(id(doc.uri)).text, 'edited');
  f.disk.delete(id(doc.uri)); f.watcherEvents.delete(doc.uri);
  assert.equal(f.index.get(id(doc.uri)).text, 'edited'); f.close(doc); await f.service.ready();
  assert.equal(f.index.get(id(doc.uri)), undefined);
  f.disk.set('file:///work/c.ll', 'c'); f.watcherEvents.create(uri('file:///work/c.ll')); await f.service.ready();
  assert.equal(f.index.get('file:///work/c.ll').text, 'c');
  f.disk.delete('file:///work/c.ll'); f.watcherEvents.delete(uri('file:///work/c.ll'));
  assert.equal(f.index.get('file:///work/c.ll'), undefined); f.service.dispose();
});

test('initial open text wins disk and closing discards unsaved changes', async () => {
  const f = fixture(); const doc = f.document('file:///work/a.ll', 'unsaved'); f.workspace.textDocuments.push(doc);
  await f.service.start(); assert.equal(f.index.get(id(doc.uri)).text, 'unsaved');
  f.close(doc); await f.service.ready(); assert.equal(f.index.get(id(doc.uri)).text, 'declare void @a()');
});

for (const stage of ['stat', 'read']) {
  test(`delayed ${stage} cannot replace reopened/edited buffer`, async () => {
    const f = fixture(); await f.service.start();
    const doc = f.document('file:///work/a.ll', 'old buffer'); f.open(doc);
    const gate = pause(), entered = pause(); f.hooks[stage] = async () => { entered.resolve(); await gate.promise; };
    f.close(doc); await entered.promise;
    const reopened = f.document(id(doc.uri), 'new buffer'); f.open(reopened); reopened.change('newest buffer');
    gate.resolve(); await f.service.ready(); assert.equal(f.index.get(id(doc.uri)).text, 'newest buffer');
  });
  for (const event of ['delete', 'rescan', 'dispose', 'folder']) {
    test(`delayed ${stage} cannot publish after ${event}`, async () => {
      const f = fixture(); await f.service.start();
      const gate = pause(), entered = pause(); let once = true;
      f.hooks[stage] = async () => { if (once) { once = false; entered.resolve(); await gate.promise; } };
      f.watcherEvents.change(uri('file:///work/a.ll')); await entered.promise;
      if (event === 'delete') f.watcherEvents.delete(uri('file:///work/a.ll'));
      if (event === 'rescan') { f.settings['llvmIR.workspace.enabled'] = false; f.events.onDidChangeConfiguration({ affectsConfiguration: () => true }); }
      if (event === 'dispose') f.service.dispose();
      if (event === 'folder') { f.workspace.workspaceFolders = []; f.events.onDidChangeWorkspaceFolders(); }
      gate.resolve(); await f.service.ready(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.index.get('file:///work/a.ll'), undefined);
    });
  }
}

test('workspace roots and configured project roots use segment boundaries and URI identity', async () => {
  const f = fixture({}, { 'llvmIR.workspace.projectRoots': ['hw0', 'hw0/nested', '../bad', '/bad', 'a%2fb', 'x://y'] });
  f.workspace.workspaceFolders.push({ uri: uri('vscode-remote://host/work') }); await f.service.start();
  assert.equal(f.service.rootFor(uri('file:///work/hw0/a.ll')), 'file:///work/hw0');
  assert.equal(f.service.rootFor(uri('file:///work/hw0/nested/a.ll')), 'file:///work/hw0/nested');
  assert.equal(f.service.rootFor(uri('file:///work/hw01/a.ll')), 'file:///work');
  assert.equal(f.service.rootFor(uri('file:///work2/a.ll')), 'file:///work2/a.ll');
  assert.equal(f.service.rootFor(uri('file:///work/hw0%2fnested/a.ll')), 'file:///work/hw0%2fnested/a.ll');
  assert.equal(f.service.rootFor(uri('vscode-remote://host/work/hw0/a.ll')), 'vscode-remote://host/work/hw0');
  assert.equal(f.service.rootFor(uri('untitled:Untitled-1')), 'untitled:Untitled-1');
  assert.ok(f.logs.some(line => line.includes('invalid projectRoots')));
});

test('explicit and configured boolean excludes isolate buffers and skip disk reads', async () => {
  const f = fixture({ 'file:///work/build/a.ll': 'a', 'file:///work/generated/b.ll': 'b', 'file:///work/search/c.ll': 'c', 'file:///work/a.ll': 'ok' },
    { 'files.exclude': { '**/generated/**': true }, 'search.exclude': { '**/search/**': true, '**/*.sibling': { when: '$(basename).ll' } } });
  await f.service.start(); assert.deepEqual(f.index.documents().map(doc => doc.text), ['ok']);
  assert.ok(f.hooks.lastFind.exclude.includes('generated'));
  // VS Code 1.85's ripgrep fails on nested alternate groups.
  assert.doesNotMatch(f.hooks.lastFind.exclude.slice(1, -1), /[{}]/, f.hooks.lastFind.exclude);
  assert.ok(f.hooks.lastFind.exclude.includes('**/node_modules/**'));
  const doc = f.document('file:///work/build/a.ll', 'open'); f.open(doc);
  assert.equal(f.index.get(id(doc.uri)).root, id(doc.uri));
  const custom = f.document('file:///work/source.txt', 'define void @f() {}'); f.open(custom);
  assert.equal(f.index.get(id(custom.uri)).root, id(custom.uri));
  assert.ok(f.logs.some(line => line.includes('conditional sibling')));
});

test('file count, bytes, aggregate bytes and unreadable inputs mark incomplete; overlays count', async () => {
  const f = fixture({ 'file:///work/a.ll': 'a', 'file:///work/b.ll': 'b' }, { 'llvmIR.workspace.maxFiles': 1 });
  await f.service.start(); assert.equal(f.index.documents().length, 1);
  assert.equal(f.service.status(uri('file:///work/a.ll')).complete, false);
  const second = f.document('file:///work/b.ll', 'open'); f.open(second);
  assert.equal(f.index.get(id(second.uri)).root, id(second.uri));
  const g = fixture({ 'file:///work/a.ll': 'x'.repeat(1025) }, { 'llvmIR.workspace.maxFileBytes': 1024 });
  await g.service.start(); assert.equal(g.index.documents().length, 0); assert.equal(g.service.status(uri('file:///work/a.ll')).complete, false);
  const h = fixture({ 'file:///work/a.ll': 'a'.repeat(700), 'file:///work/b.ll': 'b'.repeat(700) }, { 'llvmIR.workspace.maxTotalBytes': 1024 });
  await h.service.start(); assert.equal(h.index.documents().length, 1); assert.equal(h.service.status(uri('file:///work/a.ll')).complete, false);
  const j = fixture(); j.hooks.read = () => { throw Error('denied'); }; await j.service.start();
  assert.equal(j.service.status(uri('file:///work/a.ll')).complete, false);
});

test('disable/re-enable removes disk entries but retains isolated live editing', async () => {
  const f = fixture(); await f.service.start(); const doc = f.document('file:///work/b.ll', 'b'); f.open(doc);
  f.settings['llvmIR.workspace.enabled'] = false; f.events.onDidChangeConfiguration({ affectsConfiguration: () => true }); await f.service.ready();
  assert.equal(f.index.get('file:///work/a.ll'), undefined); assert.equal(f.index.get(id(doc.uri)).root, id(doc.uri));
  f.settings['llvmIR.workspace.enabled'] = true; f.events.onDidChangeConfiguration({ affectsConfiguration: () => true }); await f.service.ready();
  assert.equal(f.index.get('file:///work/a.ll').root, 'file:///work'); assert.equal(f.index.get(id(doc.uri)).root, 'file:///work');
});

test('validateEdits checks dirty buffers, disk freshness and all identities after awaits', async () => {
  const f = fixture({ 'file:///work/a.ll': 'a', 'file:///work/b.ll': 'b' }); await f.service.start();
  const edits = ['a', 'b'].map(name => ({ uri: `file:///work/${name}.ll`, start: 0, end: 1, newText: 'c' }));
  assert.equal(await f.service.validateEdits(edits), true);
  f.disk.set('file:///work/a.ll', 'changed'); assert.equal(await f.service.validateEdits(edits), false);
  f.disk.set('file:///work/a.ll', 'a');
  const doc = f.document('file:///work/a.ll', 'dirty'); f.open(doc); assert.equal(await f.service.validateEdits(edits), true);
  const gate = pause(), entered = pause(); f.hooks.read = async path => { if (path.endsWith('/b.ll')) { entered.resolve(); await gate.promise; } };
  const pending = f.service.validateEdits(edits); await entered.promise; doc.change('new dirty'); gate.resolve();
  assert.equal(await pending, false);
  assert.equal(await f.service.validateEdits([{ uri: 'file:///missing.ll' }]), false);
  assert.equal(f.disk.get('file:///work/a.ll'), 'a');
});

test('minimal mocks keep local-only operations available and disposal is idempotent', async () => {
  const index = new Map(); const adapter = { get: uri => index.get(uri), upsert: (uri, text, options) => index.set(uri, { uri, text, ...options }), documents: () => [...index.values()], remove: uri => index.delete(uri), clear: () => index.clear() };
  const service = createWorkspaceService({ workspace: {} }, null, adapter);
  const doc = { uri: uri('untitled:a'), languageId: 'llvm-ir', version: 1, getText: () => 'a' };
  await service.ensure(doc); assert.equal(index.get('untitled:a').text, 'a'); assert.equal(service.status(doc).complete, true);
  service.dispose(); service.dispose(); await service.ensure(doc); assert.equal(index.size, 0);
});

test('watcher bursts serialize background reads and directory deletion invalidates pending children', async () => {
  const f = fixture({ 'file:///work/dir/a.ll': 'a', 'file:///work/dir/b.ll': 'b' }); await f.service.start();
  let active = 0, max = 0; const gate = pause(), entered = pause();
  f.hooks.read = async () => { active++; max = Math.max(max, active); entered.resolve(); await gate.promise; active--; };
  f.watcherEvents.change(uri('file:///work/dir/a.ll'));
  f.watcherEvents.change(uri('file:///work/dir/b.ll'));
  await entered.promise;
  f.watcherEvents.delete(uri('file:///work/dir'));
  gate.resolve(); await f.service.ready();
  assert.equal(max, 1); assert.equal(f.index.documents().length, 0);
});

test('obsolete discovery cannot publish after config rescan', async () => {
  const f = fixture(); const gate = pause(), entered = pause();
  f.hooks.find = async () => { entered.resolve(); await gate.promise; };
  const pending = f.service.start(); await entered.promise;
  f.settings['llvmIR.workspace.enabled'] = false;
  f.events.onDidChangeConfiguration({ affectsConfiguration: () => true });
  gate.resolve(); await pending; await f.service.ready(); assert.equal(f.index.documents().length, 0);
});

test('rename preflight rejects a changed non-target module or new index member', async () => {
  for (const operation of ['changed', 'added']) {
    const f = fixture({ 'file:///work/a.ll': 'a', 'file:///work/other.ll': 'other' }); await f.service.start();
    const gate = pause(), entered = pause(); f.hooks.read = async () => { entered.resolve(); await gate.promise; };
    const pending = f.service.validateEdits([{ uri: 'file:///work/a.ll', start: 0, end: 1, newText: 'x' }]);
    await entered.promise;
    if (operation === 'changed') f.open(f.document('file:///work/other.ll', 'new conflicting definition'));
    else f.index.upsert('file:///work/new.ll', 'new reference', { root: 'file:///work' });
    gate.resolve(); assert.equal(await pending, false);
  }
});

test('irrelevant watcher changes neither read files nor invalidate rename preflight', async () => {
  const f = fixture(); await f.service.start();
  const gate = pause(), entered = pause(); let reads = 0;
  f.hooks.read = async () => { reads++; entered.resolve(); await gate.promise; };
  const pending = f.service.validateEdits([{ uri: 'file:///work/a.ll', start: 0, end: 1, newText: 'x' }]);
  await entered.promise;
  f.watcherEvents.create(uri('file:///work/node_modules/irrelevant.js'));
  gate.resolve(); assert.equal(await pending, true); await f.service.ready(); assert.equal(reads, 1);
});

test('stale discovery cannot resurrect a file deleted before its read was scheduled', async () => {
  const f = fixture(); const gate = pause(), entered = pause();
  f.hooks.find = async () => { entered.resolve(); await gate.promise; };
  const pending = f.service.start(); await entered.promise;
  // Simulate a remote provider whose discovery and read cache still sees the
  // deleted file after its authoritative watcher deletion event.
  f.watcherEvents.delete(uri('file:///work/a.ll'));
  gate.resolve(); await pending; await f.service.ready();
  assert.equal(f.index.get('file:///work/a.ll'), undefined);
});

test('brace expansion flattens nested alternatives for older ripgrep', () => {
  const { expandBraces } = require('../src/workspace');
  assert.deepEqual(expandBraces('**/{.git,node_modules}/**'), ['**/.git/**', '**/node_modules/**']);
  assert.deepEqual(expandBraces('a/{b,c{d,e}}/*.{ll,llvm}'), ['a/b/*.ll', 'a/b/*.llvm', 'a/cd/*.ll', 'a/cd/*.llvm', 'a/ce/*.ll', 'a/ce/*.llvm']);
  assert.deepEqual(expandBraces('[{]x'), ['[{]x']);
  assert.deepEqual(expandBraces('plain/**'), ['plain/**']);
  const huge = '{a,b}'.repeat(10);
  assert.deepEqual(expandBraces(huge), [huge]);
});
