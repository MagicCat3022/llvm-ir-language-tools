'use strict';

const { analyze, tokenAt, symbolAt, references } = require('./analysis');
const { canonicalName, decodedName } = require('./symbol-names');

const linkages = new Set('private internal available_externally linkonce weak common appending extern_weak linkonce_odr weak_odr external'.split(' '));
const presentation = new Set('define declare private internal available_externally linkonce weak common appending extern_weak linkonce_odr weak_odr external default hidden protected dso_local dso_preemptable dllimport dllexport unnamed_addr local_unnamed_addr ccc'.split(' '));
const replaceable = new Set('available_externally linkonce weak common appending extern_weak linkonce_odr weak_odr'.split(' '));
const isGlobal = symbol => symbol && symbol.scope === null && symbol.name.startsWith('@');
const numbered = name => /^@\d+$/.test(name);
const reserved = name => decodedName(name).startsWith('llvm.');
const target = (document, symbol, span = symbol) => ({ uri: document.uri, start: span.start, end: span.end, symbol });
const error = message => ({ edits: [], error: message });

function splitParameters(tokens) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if ('([{<'.includes(token.text)) depth++;
    if (')]}>'.includes(token.text)) depth--;
    if (token.text === ',' && depth === 0) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts.filter(part => part.length);
}

function metadata(document, symbol) {
  const end = symbol.kind === 'function' ? symbol.fullStart + symbol.definition.length : symbol.fullEnd;
  const tokens = document.analysis.tokens.filter(token => token.start >= symbol.fullStart && token.start < end && token.kind !== 'comment');
  const nameIndex = tokens.findIndex(token => token.start === symbol.start);
  const marker = tokens.findIndex((token, index) => index > nameIndex && ['global', 'constant', 'alias', 'ifunc'].includes(token.text));
  const prefix = symbol.kind === 'function' ? tokens.slice(0, nameIndex) : tokens.slice(nameIndex + 2, marker < 0 ? undefined : marker);
  const linkage = prefix.find(token => linkages.has(token.text))?.text || 'external';
  const local = linkage === 'private' || linkage === 'internal' || numbered(symbol.name);
  const declaration = symbol.kind === 'function' ? !!symbol.declaration : prefix.some(token => ['external', 'extern_weak'].includes(token.text));
  const alias = ['alias', 'ifunc'].includes(tokens[marker]?.text);
  const layout = moduleInfo(document).layout;
  const defaultAddressSpace = kind => {
    const component = layout && decodedName(layout).split('-').find(part => new RegExp(`^${kind}\\d+$`).test(part));
    return component ? component.slice(1) : '0';
  };
  let signature;
  let uncertain = symbol.type === 'unknown' || /%/.test(symbol.type);
  if (symbol.kind === 'function') {
    let close = nameIndex + 1, depth = 0;
    for (; close < tokens.length; close++) {
      if (tokens[close].text === '(') depth++;
      if (tokens[close].text === ')' && --depth === 0) break;
    }
    const params = splitParameters(tokens.slice(nameIndex + 2, close));
    const paramNames = new Set((symbol.parameters || []).filter(param => param.name).map(param => param.start));
    const normalizedParams = params.map(part => part.filter(token => !paramNames.has(token.start)).map(token => token.text).join(' '));
    const suffix = tokens.slice(close + 1);
    const address = suffix.findIndex(token => token.text === 'addrspace');
    const addressSpace = address < 0 ? defaultAddressSpace('P') : suffix[address + 2]?.text;
    signature = JSON.stringify(['function', prefix.filter(token => !presentation.has(token.text)).map(token => token.text).join(' '), normalizedParams, addressSpace]);
    uncertain ||= !addressSpace || close >= tokens.length || tokens.some(token => token.text.startsWith('#')) || normalizedParams.some(part => /%/.test(part));
  } else {
    // Thread-local models and address spaces are part of a global's identity
    // constraints, unlike visibility and dso_local (which do not localize it).
    const address = prefix.findIndex(token => token.text === 'addrspace');
    const addressSpace = address < 0 ? defaultAddressSpace('G') : prefix[address + 2]?.text;
    const qualifiers = prefix.filter((token, index) => !presentation.has(token.text) &&
      !(address >= 0 && index >= address && index < address + 4)).map(token => token.text).join(' ');
    signature = JSON.stringify(['global', symbol.type, qualifiers, tokens[marker]?.text, addressSpace]);
    uncertain ||= marker < 0;
  }
  return { linkage, local, declaration, alias, signature, uncertain,
    comdat: tokens.some(token => token.text === 'comdat') };
}

// Joins tokens as LLVM prints them: `addrspace(1)`, `range(i32 0, 10)`, `{ i32, ptr }`.
function spell(tokens) {
  return tokens.map((token, i) => (i && !/^[),\]>]$/.test(token.text) && !/^[([<]$/.test(tokens[i - 1].text) &&
    !(token.text === '(' && tokens[i - 1].kind === 'word') ? ' ' : '') + token.text).join('');
}

// A declaration that imports `symbol` from its defining module, or undefined
// when it would need named types or has no parsed signature.
function declarationText(document, symbol) {
  if (symbol.type === 'unknown' || /%/.test(symbol.type)) return undefined;
  const end = symbol.kind === 'function' ? symbol.fullStart + symbol.definition.length : symbol.fullEnd;
  const tokens = document.analysis.tokens.filter(token => token.start >= symbol.fullStart && token.start < end && token.kind !== 'comment');
  const nameIndex = tokens.findIndex(token => token.start === symbol.start);
  const addressSpace = list => {
    const i = list.findIndex(token => token.text === 'addrspace');
    return i < 0 ? [] : list.slice(i, i + 4);
  };
  if (symbol.kind === 'function') {
    let close = nameIndex + 1, depth = 0;
    for (; close < tokens.length; close++) {
      if (tokens[close].text === '(') depth++;
      if (tokens[close].text === ')' && --depth === 0) break;
    }
    if (close >= tokens.length) return undefined;
    const names = new Set((symbol.parameters || []).filter(param => param.name).map(param => param.start));
    const params = splitParameters(tokens.slice(nameIndex + 2, close)).map(part => spell(part.filter(token => !names.has(token.start))));
    const prefix = tokens.slice(0, nameIndex).filter(token => !presentation.has(token.text));
    if (params.some(param => /%/.test(param)) || prefix.some(token => token.text.startsWith('#'))) return undefined;
    const space = addressSpace(tokens.slice(close + 1));
    return `declare ${spell(prefix)} ${symbol.name}(${params.join(', ')})${space.length ? ' ' + spell(space) : ''}`;
  }
  const marker = tokens.findIndex((token, index) => index > nameIndex && ['global', 'constant', 'alias', 'ifunc'].includes(token.text));
  if (!['global', 'constant'].includes(tokens[marker]?.text)) return undefined;
  const qualifiers = [];
  const prefix = tokens.slice(nameIndex + 2, marker);
  const local = prefix.findIndex(token => token.text === 'thread_local');
  if (local >= 0) qualifiers.push(spell(prefix[local + 1]?.text === '(' ? prefix.slice(local, local + 4) : [prefix[local]]));
  if (addressSpace(prefix).length) qualifiers.push(spell(addressSpace(prefix)));
  if (prefix.some(token => token.text === 'externally_initialized')) qualifiers.push('externally_initialized');
  return `${symbol.name} = external ${[...qualifiers, tokens[marker].text].join(' ')} ${symbol.type}`;
}

function moduleInfo(document) {
  const tokens = document.analysis.tokens.filter(token => token.kind !== 'comment');
  const setting = name => {
    const i = tokens.findIndex((token, index) => token.text === name && tokens[index - 1]?.text === 'target' && tokens[index + 1]?.text === '=');
    return i < 0 ? undefined : tokens[i + 2]?.text;
  };
  return { triple: setting('triple'), layout: setting('datalayout'),
    asm: tokens.some(token => token.kind === 'word' && token.text === 'asm'),
    linkerOptions: tokens.some(token => token.kind === 'identifier' && token.text === '!llvm.linker.options'),
    debugLinkageNames: tokens.filter((token, index) => token.kind === 'string' && tokens[index - 1]?.text === ':' && tokens[index - 2]?.text === 'linkageName').map(token => decodedName(token.text)) };
}

function compatibleModules(left, right) {
  // Missing target information is not a wildcard: P/G datalayout defaults can
  // change omitted function/global address spaces, and target-specific ABI
  // choices cannot be proved compatible with an unspecified target. Exact
  // source spellings may reject equivalent layouts; conservative by design.
  return left.triple === right.triple && left.layout === right.layout;
}

class WorkspaceIndex {
  // `analyze(text, uri)` may return an analysis the editor already computed
  // for identical text, so an open document is analyzed once per edit.
  constructor({ analyze: analyzer = analyze } = {}) { this._analyze = analyzer; this._documents = new Map(); this._metadata = new WeakMap(); this._modules = new WeakMap(); this._listeners = new Set(); }
  // Notifies after a snapshot is added, replaced or removed.
  onDidChange(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }
  _changed(uri) { for (const listener of this._listeners) listener(uri); }
  upsert(uri, text, { root, version } = {}) {
    const document = { uri, root, text, version, analysis: this._analyze(text, uri) };
    this._documents.set(uri, document);
    this._changed(uri);
    return document;
  }
  get(uri) { return this._documents.get(uri); }
  remove(uri) { if (this._documents.delete(uri)) this._changed(uri); }
  clear() { this._documents.clear(); }
  documents() { return [...this._documents.values()]; }
  _meta(document, symbol) {
    if (!this._metadata.has(symbol)) this._metadata.set(symbol, metadata(document, symbol));
    return this._metadata.get(symbol);
  }
  _module(document) {
    if (!this._modules.has(document)) this._modules.set(document, moduleInfo(document));
    return this._modules.get(document);
  }
  _candidates(document, name) {
    const key = canonicalName(name), result = [];
    for (const other of this._documents.values()) {
      if (other.root !== document.root) continue;
      for (const symbol of other.analysis.symbols) {
        if (!isGlobal(symbol) || canonicalName(symbol.name) !== key) continue;
        const meta = this._meta(other, symbol);
        if (!meta.local) result.push({ document: other, symbol, meta });
      }
    }
    return result;
  }
  definitions(uri, offset) {
    const document = this.get(uri);
    if (!document) return [];
    const symbol = symbolAt(document.analysis, offset);
    if (symbol && !isGlobal(symbol)) return [target(document, symbol)];
    if (symbol) {
      const meta = this._meta(document, symbol);
      if (meta.local || !meta.declaration) return [target(document, symbol)];
      const candidates = this._candidates(document, symbol.name).filter(item => !item.meta.declaration &&
        compatibleModules(this._module(document), this._module(item.document)) && item.meta.signature === meta.signature);
      return candidates.length ? candidates.map(item => target(item.document, item.symbol)) : [target(document, symbol)];
    }
    const token = tokenAt(document.analysis, offset);
    if (token?.kind !== 'identifier' || !token.text.startsWith('@') || numbered(token.text)) return [];
    const candidates = this._candidates(document, token.text).filter(item => compatibleModules(this._module(document), this._module(item.document)));
    const definitions = candidates.filter(item => !item.meta.declaration);
    return (definitions.length ? definitions : candidates).map(item => target(item.document, item.symbol));
  }
  references(uri, offset, includeDeclaration = true) {
    const document = this.get(uri);
    if (!document) return [];
    const symbol = symbolAt(document.analysis, offset);
    if (!symbol) return [];
    const local = () => references(document.analysis, symbol, includeDeclaration).map(span => target(document, symbol, span));
    if (!isGlobal(symbol)) return local();
    const meta = this._meta(document, symbol);
    if (meta.local || meta.uncertain) return local();
    const result = new Map();
    for (const item of this._candidates(document, symbol.name)) {
      if (item.meta.uncertain || item.meta.signature !== meta.signature || !compatibleModules(this._module(document), this._module(item.document))) continue;
      for (const span of references(item.document.analysis, item.symbol, includeDeclaration)) {
        result.set(`${item.document.uri}\0${span.start}`, target(item.document, item.symbol, span));
      }
    }
    return [...result.values()];
  }
  completions(uri, _offset) {
    const document = this.get(uri);
    if (!document) return [];
    const seen = new Set(document.analysis.symbols.filter(isGlobal).map(symbol => canonicalName(symbol.name)));
    const result = [];
    for (const other of this._documents.values()) {
      if (other.root !== document.root || !compatibleModules(this._module(document), this._module(other))) continue;
      for (const symbol of other.analysis.symbols) {
        if (!isGlobal(symbol) || reserved(symbol.name) || this._meta(other, symbol).local) continue;
        const key = canonicalName(symbol.name);
        if (seen.has(key)) continue;
        seen.add(key); result.push(target(other, symbol));
      }
    }
    return result;
  }
  // One declaration every compatible external candidate agrees on; otherwise
  // the link result is unknown and nothing is inserted.
  declaration(uri, name) {
    const document = this.get(uri);
    if (!document) return undefined;
    const texts = new Set(this._candidates(document, name).filter(item => !item.meta.alias &&
      compatibleModules(this._module(document), this._module(item.document))).map(item => declarationText(item.document, item.symbol)));
    return texts.size === 1 ? [...texts][0] : undefined;
  }
  search(query = '', root) {
    const needle = query.toLowerCase(), result = [];
    for (const document of this._documents.values()) {
      if (root !== undefined && document.root !== root) continue;
      for (const symbol of document.analysis.symbols) {
        if (symbol.scope !== null || !['function', 'global', 'type'].includes(symbol.kind) || !decodedName(symbol.name).toLowerCase().includes(needle)) continue;
        result.push(target(document, symbol));
        if (result.length === 200) return result;
      }
    }
    return result;
  }
  rename(uri, offset, newName) {
    const document = this.get(uri);
    if (!document) return undefined;
    const symbol = symbolAt(document.analysis, offset);
    if (!isGlobal(symbol)) return undefined;
    let replacement = newName;
    if (typeof replacement !== 'string') return error('Enter a valid LLVM global name.');
    if (!replacement.startsWith('@')) replacement = '@' + replacement;
    if (!/^@(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|"(?:[^"\\\r\n\x00]|\\[\da-fA-F]{2})*")$/.test(replacement)) return error('Use a named LLVM global (optionally quoted with two-digit hexadecimal escapes); numbered slots cannot be renamed.');
    if (numbered(symbol.name)) return error('Numbered globals are module-local slots and cannot be renamed safely.');
    if (reserved(symbol.name) || reserved(replacement)) return error('LLVM-reserved llvm.* names cannot be renamed.');
    const meta = this._meta(document, symbol);
    if (meta.alias) return error('Alias and ifunc identities require linker-aware refactoring and cannot be renamed here.');
    const candidates = meta.local ? [{ document, symbol, meta }] : this._candidates(document, symbol.name);
    if (candidates.some(item => item.meta.alias)) return error('A same-name alias or ifunc makes this rename unsafe.');
    if (candidates.some(item => item.meta.comdat)) return error('COMDAT-associated symbols require coordinated group renaming; rename them manually.');
    if (candidates.some(item => this._module(item.document).asm)) return error('A participating module contains assembly, whose symbol names cannot be updated safely.');
    if (!meta.local) {
      if (candidates.some(item => replaceable.has(item.meta.linkage))) return error('Weak, replaceable, appending, or available_externally linkage makes workspace rename unsafe.');
      if (candidates.filter(item => !item.meta.declaration).length !== 1) return error('Workspace rename requires exactly one nonreplaceable definition; external-only APIs and ambiguous definitions cannot be renamed.');
      if (candidates.some(item => !compatibleModules(this._module(document), this._module(item.document)))) return error('Target triples or data layouts differ or are missing in a participating module; target compatibility cannot be proved.');
      if (candidates.some(item => item.meta.uncertain || item.meta.signature !== meta.signature)) return error('Incompatible or unsupported ABI signatures (including named types or attribute groups) prevent safe cross-file rename.');
    }
    const oldKey = canonicalName(symbol.name), newKey = canonicalName(replacement);
    const documents = new Set(candidates.map(item => item.document));
    for (const other of this._documents.values()) {
      if (other.root !== document.root || (meta.local && other !== document)) continue;
      const info = this._module(other);
      if (info.asm) return error('A project module contains assembly, which may contain undeclared symbol references; rename cannot update it safely.');
      if (info.linkerOptions) return error('A project module contains string-based LLVM linker options; rename cannot safely update their symbol references.');
      if (info.debugLinkageNames.includes(decodedName(symbol.name))) return error('Debug metadata stores this symbol in a linkageName string; coordinate that metadata change manually.');
      // A missing local declaration is invalid IR, but is also common while
      // typing. Do not offer an apparently complete rename that drops such a
      // reference, or one hidden by an unsupported/incomplete declaration.
      if (other.analysis.tokens.some(token => token.kind === 'identifier' && canonicalName(token.text) === oldKey && !symbolAt(other.analysis, token.start))) return error(`An unresolved reference in ${other.uri} prevents a complete rename; finish its declaration first.`);
      if (other.analysis.symbols.some(entry => isGlobal(entry) && canonicalName(entry.name) === newKey && newKey !== oldKey &&
        (documents.has(other) || !this._meta(other, entry).local))) return error(`The new name already exists in ${other.uri}; no files were changed.`);
    }
    const edits = new Map();
    for (const item of candidates) {
      for (const span of references(item.document.analysis, item.symbol, true)) {
        edits.set(`${item.document.uri}\0${span.start}`, { uri: item.document.uri, start: span.start, end: span.end, newText: replacement });
      }
    }
    return { edits: [...edits.values()] };
  }
}

module.exports = { WorkspaceIndex };
