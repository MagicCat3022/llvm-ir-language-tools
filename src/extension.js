'use strict';

const vscode = require('vscode');
const analysis = require('./analysis');
const knowledge = require('./knowledge');
const { verifyIR } = require('./diagnostics');
const { WorkspaceIndex } = require('./workspace-index');
const { createWorkspaceService } = require('./workspace');
const { attachWorkspaceProviders } = require('./workspace-providers');
const { lookupLibrary, libraryParameters } = require('./library');
const { checkIR } = require('./checks');
const { createCheckManager, positionsIn } = require('./check-manager');
const { createGraphView } = require('./cfg-view');
const { createStatus, unavailableSummary } = require('./status');

const selector = { language: 'llvm-ir' };
const tokenTypes = ['function', 'variable', 'parameter', 'type', 'label', 'namespace', 'decorator'];
const semanticKinds = { function: 0, global: 1, variable: 1, parameter: 2, type: 3, label: 4, metadata: 5, attribute: 6 };
const spanRange = (document, span) => new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
const config = document => vscode.workspace.getConfiguration('llvmIR', document.uri);

function markdown() {
  const result = new vscode.MarkdownString();
  result.isTrusted = false;
  return result;
}

function signatureLabel(symbol) {
  const parameters = (symbol.parameters || []).map(parameter => `${parameter.type}${parameter.name ? ` ${parameter.name}` : ''}`);
  if (symbol.variadic) parameters.push('...');
  return `${symbol.returnType || 'unknown'} ${symbol.name}(${parameters.join(', ')})`;
}

function symbolLocation(symbol, document) {
  const line = document.positionAt(symbol.start).line + 1;
  return `Line ${line}${symbol.scope ? ` in ${symbol.scope}` : ''}`;
}

// Bound popup size without changing source or silently pretending it is complete.
function boundedSource(source) {
  const lines = source.slice(0, 1001).split(/\r?\n/);
  let preview = lines.slice(0, 10).join('\n');
  if (preview.length > 1000) {
    preview = preview.slice(0, 1000);
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  }
  return { preview, truncated: lines.length > 10 || source.length > 1000 };
}
const truncationNote = 'Preview truncated. Use Go to Definition for the full source.';

function sourcePreview(result, source) {
  const { preview, truncated } = boundedSource(source);
  result.appendCodeblock(preview, 'llvm-ir');
  if (truncated) result.appendText(truncationNote + '\n\n');
}

// Hovers follow the Pylance layout: a `(kind) signature` block, a rule, then
// prose paragraphs. The rule is emitted once, before the first paragraph.
const ruled = new WeakSet();
function paragraph(result) {
  result.appendMarkdown(ruled.has(result) ? '\n\n' : '\n\n---\n\n');
  ruled.add(result);
  return result;
}

function hoverHeader(result, kind, source) {
  const { preview, truncated } = boundedSource(`(${kind}) ${source}`);
  result.appendCodeblock(preview, 'llvm-ir');
  if (truncated) paragraph(result).appendText(truncationNote);
  return result;
}

// `@name = rest` becomes `@name: type = rest`, mirroring `(variable) x: int`.
function typedDefinition(symbol, type) {
  const afterName = (symbol.definition || '').slice(symbol.name.length);
  const expression = /^\s*=/.test(afterName) ? afterName.replace(/^\s*=\s*/, ' = ') : '';
  return `${symbol.name}${type ? `: ${type}` : ''}${expression}`;
}

const opaquePointer = type => /^ptr(?: addrspace\(\d+\))?$/.test(type || '');
const code = text => text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;

// One `pointee — reason` line per inferred part of a pointee, shared by hovers and
// inlay tooltips. Facts the instruction states outright need no explanation.
// `→ @g` means "points to @g", so reasons speak of addresses, never of a
// variable *being* the global.
function pointerNotes(symbol) {
  const notes = [];
  const note = (term, reason) => notes.push(`${code(term)} — ${reason}`);
  const indexed = (access, what) => `${access.via ? code(access.via) : 'a `getelementptr` here'} indexes ${what} as this type`;
  const { address, valueHint: value, receiverHint: receiver } = symbol;
  if (value?.field) note(value.value + '?', `the only address stored to field ${value.field.index} of ${code(value.field.of)} (in ${code(value.via)})`);
  else if (value?.table) note(value.value + (value.hint ? '?' : ''), `the address in element ${value.table.index} of ${code(value.table.global)}`);
  else if (address?.table?.hint) note(`${address.table.global}[${address.table.index}]?`, `${code(address.table.base)} likely points to ${code(address.table.global)}`);
  else if (address?.field) note(address.type, `field ${address.field.index} of ${code(address.field.of)}`);
  else if (symbol.storedPointerAccess) note(symbol.storedPointerAccess.type + '?', indexed(symbol.storedPointerAccess, 'the stored pointer'));
  else if (symbol.accessType) note(symbol.accessType.type + '?', indexed(symbol.accessType, 'it'));
  else if (receiver) note(receiver.types.join(' | ') + '?', `listed in ${receiver.tables.map(code).join(', ')}`);
  return notes;
}

// The most specific thing a pointer refers to: a named global or function,
// a table entry, or a type. Slots chain through the pointer they hold. A
// trailing `?` marks a hint (access types, likely values and receivers) as
// opposed to what the instruction itself states.
function pointee(symbol) {
  const likely = (text, hint = true) => text + (hint ? '?' : '');
  if (symbol.valueHint) return likely(symbol.valueHint.value, symbol.valueHint.hint);
  if (symbol.address?.table) return likely(`${symbol.address.table.global}[${symbol.address.table.index}]`, symbol.address.table.hint);
  if (symbol.address) return symbol.address.type;
  if (symbol.allocatedType) return symbol.storedPointerAccess ? `${symbol.allocatedType} → ${likely(symbol.storedPointerAccess.type)}` : symbol.allocatedType;
  if (symbol.accessType) return likely(symbol.accessType.type);
  if (symbol.receiverHint) return likely(symbol.receiverHint.types.join(' | '));
  return undefined;
}

// Where a block sits in its function's control flow, one fact per line.
function blockNotes(graph, block) {
  const name = i => code(graph.blocks[i].name || 'an unlabeled block');
  const list = indexes => indexes.map(name).join(', ');
  const notes = [];
  if (!block.index) notes.push('Entry block: runs first, and nothing may branch to it.');
  else if (!block.reachable) notes.push('Unreachable: no path from the entry block leads here.');
  else notes.push(`Predecessors: ${list(block.predecessors)}`);
  if (block.successors.length) notes.push(`Successors: ${list(block.successors)}`);
  else if (block.terminator) notes.push(`Leaves the function with ${code(block.terminator)}.`);
  if (block.backEdges?.length) notes.push(`Loop header: ${list(block.backEdges)} branch${block.backEdges.length === 1 ? 'es' : ''} back here.`);
  if (block.idom !== undefined) notes.push(`Immediate dominator: ${name(block.idom)}, which every path here passes through.`);
  return notes;
}

function symbolDocumentation(symbol, document, parsed, reference) {
  const result = markdown();
  if (symbol.kind === 'function') {
    // The source header preserves calling conventions and parameter attributes.
    const header = symbol.definition?.replace(/^(?:define|declare)\s+/, '').trim();
    return hoverHeader(result, 'function', header || signatureLabel(symbol));
  }
  const location = symbolLocation(symbol, document);
  // Pointers read like their inlay hint: `ptr → pointee`, with `?` marking a hint.
  const target = pointee(symbol);
  const type = symbol.type === 'unknown' ? 'Unknown' : symbol.type + (target ? ` → ${target}` : '');
  if (symbol.kind === 'label') {
    hoverHeader(result, 'label', symbol.name);
    const graph = parsed && analysis.blockGraph(parsed, symbol.start);
    const block = graph?.blocks.find(item => item.label === symbol);
    if (block) {
      for (const line of blockNotes(graph, block)) paragraph(result).appendMarkdown(line);
      // At a branch, show where it goes, like a peek.
      if (reference) {
        const { preview, truncated } = boundedSource(parsed.text.slice(block.start, block.end).trim());
        paragraph(result).appendCodeblock(preview + (truncated ? '\n…' : ''), 'llvm-ir');
      }
    }
  }
  else if (symbol.kind === 'parameter') hoverHeader(result, 'parameter', `${symbol.name}: ${type}`);
  else if (symbol.kind === 'variable') hoverHeader(result, 'variable', typedDefinition(symbol, type));
  else if (symbol.kind === 'global') hoverHeader(result, 'global', typedDefinition(symbol, symbol.type === 'unknown' ? '' : symbol.type));
  else if (symbol.kind === 'attribute') hoverHeader(result, 'attributes', (symbol.definition || symbol.name).replace(/^attributes\s+/, ''));
  else hoverHeader(result, symbol.kind, symbol.definition || symbol.name);
  for (const line of pointerNotes(symbol)) paragraph(result).appendMarkdown(line);
  paragraph(result).appendText(location);
  return result;
}

function completionPresentation(symbol, document) {
  const location = symbolLocation(symbol, document);
  const documentation = markdown();
  if (symbol.kind === 'function') {
    // The completion's detail already contains a signature.
    documentation.appendText(location);
    return { detail: signatureLabel(symbol), documentation };
  }
  if (symbol.kind === 'label') return { detail: 'Basic block · ' + location };
  if (symbol.kind === 'parameter') {
    documentation.appendText(location);
    return { detail: `${symbol.type} · Parameter`, documentation };
  }
  sourcePreview(documentation, symbol.definition || symbol.name);
  const detail = symbol.kind === 'variable'
    ? (symbol.type === 'unknown' ? 'Type not inferred' : symbol.type)
    : ({ global: 'Global', type: 'Type definition', metadata: 'Metadata', attribute: 'Attribute group' })[symbol.kind];
  return { detail: detail + ' · ' + location, documentation };
}

function keywordDocumentation(entry, word) {
  const result = markdown();
  // Alternative forms (`ret <type> <value> | ret void`) read like overloads, one per line.
  const forms = entry.syntax ? entry.syntax.split(/ \| (?![^[]*\])/) : [word];
  result.appendCodeblock(forms.map(form => `(${entry.kind}) ${form}`).join('\n'), 'llvm-ir');
  paragraph(result).appendText(entry.summary);
  if (entry.details) paragraph(result).appendMarkdown(entry.details);
  paragraph(result).appendMarkdown(`[LLVM Language Reference](${entry.url})`);
  return result;
}

// LLVM permits hex escapes in quoted names; quoted and bare spellings can name
// the same entity, so collision checks compare their decoded values.
function canonicalName(name) {
  const sigil = /^[%@!#]/.test(name) ? name[0] : '';
  let value = sigil ? name.slice(1) : name;
  if (/^\d+$/.test(value)) return `${sigil}number:${value}`;
  if (value.startsWith('"')) {
    const pieces = value.slice(1, -1).match(/\\[a-f\d]{2}|[^\\]+/gi) || [];
    value = Buffer.concat(pieces.map(piece => piece.startsWith('\\') ? Buffer.from([parseInt(piece.slice(1), 16)]) : Buffer.from(piece, 'utf8'))).toString('hex');
  } else value = Buffer.from(value, 'utf8').toString('hex');
  return `${sigil}name:${value}`;
}

function createProviders(cache = new Map(), workspace) {
  // Reuses the workspace index's analysis of identical text, and vice versa
  // (see sharedAnalyzer), so an edit is analyzed once for every consumer.
  const getAnalysis = document => {
    const key = document.uri.toString();
    let entry = cache.get(key);
    if (!entry || entry.version !== document.version) {
      const text = document.getText(), snapshot = workspace?.index.get(key);
      const value = entry?.text === text ? entry.value : snapshot?.text === text ? snapshot.analysis : analysis.analyze(text);
      entry = { version: document.version, text, value };
      cache.set(key, entry);
    }
    return entry.value;
  };
  const at = (document, position) => {
    const parsed = getAnalysis(document);
    const offset = document.offsetAt(position);
    const token = analysis.tokenAt(parsed, offset);
    const symbol = analysis.symbolAt(parsed, offset);
    const blocked = token?.kind === 'comment' || (token?.kind === 'string' && symbol?.kind !== 'label');
    return { parsed, offset, token, symbol: blocked ? undefined : symbol, blocked };
  };
  const completionKind = kind => ({ function: vscode.CompletionItemKind.Function, global: vscode.CompletionItemKind.Variable,
    variable: vscode.CompletionItemKind.Variable, parameter: vscode.CompletionItemKind.Variable, type: vscode.CompletionItemKind.Struct,
    label: vscode.CompletionItemKind.Reference, metadata: vscode.CompletionItemKind.Constant, attribute: vscode.CompletionItemKind.Property })[kind];
  const symbolKind = kind => ({ function: vscode.SymbolKind.Function, global: vscode.SymbolKind.Variable,
    variable: vscode.SymbolKind.Variable, parameter: vscode.SymbolKind.Variable, type: vscode.SymbolKind.Struct,
    label: vscode.SymbolKind.Key, metadata: vscode.SymbolKind.Constant, attribute: vscode.SymbolKind.Property })[kind];

  const hover = {
    provideHover(document, position) {
      const { token, symbol, blocked } = at(document, position);
      if (blocked || !token) return undefined;
      if (symbol) return new vscode.Hover(symbolDocumentation(symbol, document, getAnalysis(document), token.start !== symbol.start), spanRange(document, token));
      const entry = token.kind === 'word' && knowledge.lookup(token.text);
      return entry ? new vscode.Hover(keywordDocumentation(entry, token.text), spanRange(document, token)) : undefined;
    }
  };
  const symbolItem = (symbol, document, range) => {
    const item = new vscode.CompletionItem(symbol.name, completionKind(symbol.kind));
    item.insertText = symbol.name;
    item.range = range;
    return Object.assign(item, completionPresentation(symbol, document));
  };
  const keywordItem = (word, range) => {
    const entry = knowledge.lookup(word);
    const item = new vscode.CompletionItem(word, entry?.kind === 'type' ? vscode.CompletionItemKind.TypeParameter : vscode.CompletionItemKind.Keyword);
    item.range = range;
    if (entry) item.documentation = keywordDocumentation(entry, word);
    return item;
  };
  // Completion narrowed to what LLVM accepts at the cursor: branch targets,
  // predicates, or available values of the expected type (best matches first).
  function contextCompletions(document, parsed, context, offset, sigil, range) {
    if (context.kind === 'label') return sigil && sigil !== '%' ? [] : context.labels.map(label => symbolItem(label, document, range));
    if (context.kind === 'predicate') return sigil ? [] : context.predicates.map((word, i) => {
      const item = keywordItem(word, range);
      item.kind = vscode.CompletionItemKind.EnumMember;
      item.detail = knowledge.lookup(word)?.summary;
      item.sortText = String(i).padStart(2, '0');
      return item;
    });
    const { expectedType } = context;
    const globals = analysis.visibleSymbols(parsed, offset).filter(symbol => symbol.scope === null &&
      (symbol.kind === 'function' || symbol.kind === 'global' && !context.callee));
    const locals = context.callee ? context.values.filter(symbol => opaquePointer(symbol.type)) : context.values;
    const items = [];
    for (const symbol of [...locals, ...globals]) {
      if (sigil && !symbol.name.startsWith(sigil)) continue;
      const type = symbol.scope === null ? 'ptr' : symbol.type;
      const rank = !expectedType || type === expectedType ? 0 : type === 'unknown' ? 1 : -1;
      if (rank < 0) continue;
      const item = symbolItem(symbol, document, range);
      // Arguments begin with their type: `i32 %x`.
      if (context.typed) { item.insertText = `${expectedType} ${symbol.name}`; item.filterText = symbol.name; }
      item.sortText = `${rank}${symbol.scope === null ? 1 : 0}${symbol.name}`;
      items.push(item);
    }
    if (!sigil && expectedType) {
      const literals = [...(opaquePointer(expectedType) ? ['null'] : []), ...(expectedType === 'i1' ? ['true', 'false'] : []),
        ...(/^[[{<]/.test(expectedType) ? ['zeroinitializer'] : []), 'poison', 'undef'];
      for (const word of literals) {
        const item = keywordItem(word, range);
        item.kind = vscode.CompletionItemKind.Constant;
        if (context.typed) { item.insertText = `${expectedType} ${word}`; item.filterText = word; }
        item.sortText = `2${word}`;
        items.push(item);
      }
    }
    return items;
  }
  const completion = {
    provideCompletionItems(document, position) {
      const parsed = getAnalysis(document), offset = document.offsetAt(position);
      // Completion cursors normally sit just after the typed prefix.
      const previous = analysis.tokenAt(parsed, Math.max(0, offset - 1));
      const current = analysis.tokenAt(parsed, offset);
      const blockedToken = current?.kind === 'comment' || current?.kind === 'string' ? current : previous;
      if (blockedToken?.kind === 'comment' || (blockedToken?.kind === 'string' && analysis.symbolAt(parsed, blockedToken.start)?.kind !== 'label')) return [];
      let token = current && current.start < offset ? current : previous;
      if (!token || token.end < offset || !['identifier', 'word', 'number'].includes(token.kind) && !['@', '%', '!', '#'].includes(token.text)) token = undefined;
      const start = token?.start ?? offset, end = token?.end ?? offset;
      const prefix = parsed.text.slice(start, offset);
      const sigil = /^[%@!#]/.test(prefix) ? prefix[0] : '';
      const range = spanRange(document, { start, end });
      const context = analysis.completionContext(parsed, offset, start);
      if (context) return contextCompletions(document, parsed, context, offset, sigil, range);
      const items = analysis.visibleSymbols(parsed, offset).filter(symbol => !sigil || symbol.name.startsWith(sigil)).map(symbol => symbolItem(symbol, document, range));
      if (!sigil) for (const word of Object.keys(knowledge.entries)) items.push(keywordItem(word, range));
      return items;
    }
  };
  const signatures = {
    provideSignatureHelp(document, position) {
      const { parsed, offset, blocked } = at(document, position);
      const previous = analysis.tokenAt(parsed, offset - 1);
      if (blocked || previous?.kind === 'comment' || previous?.kind === 'string') return undefined;
      const call = analysis.callAt(parsed, offset);
      if (!call) return undefined;
      const documentation = markdown();
      documentation.appendText(symbolLocation(call.symbol, document));
      const signature = new vscode.SignatureInformation(signatureLabel(call.symbol), documentation);
      signature.parameters = (call.symbol.parameters || []).map(parameter => new vscode.ParameterInformation(`${parameter.type}${parameter.name ? ` ${parameter.name}` : ''}`));
      if (call.symbol.variadic) signature.parameters.push(new vscode.ParameterInformation('...'));
      const help = new vscode.SignatureHelp();
      help.signatures = [signature];
      help.activeSignature = 0;
      help.activeParameter = Math.min(call.activeParameter, Math.max(0, signature.parameters.length - 1));
      return help;
    }
  };
  const definition = {
    provideDefinition(document, position) {
      const { symbol } = at(document, position);
      return symbol ? new vscode.Location(document.uri, spanRange(document, symbol)) : undefined;
    }
  };
  const references = {
    provideReferences(document, position, context) {
      const { parsed, symbol } = at(document, position);
      return symbol ? analysis.references(parsed, symbol, context.includeDeclaration).map(span => new vscode.Location(document.uri, spanRange(document, span))) : [];
    }
  };
  const renameTarget = (document, position) => {
    const target = at(document, position);
    if (!target.symbol) throw new Error('No LLVM symbol at this position.');
    if (/^[%@!#]\d+$/.test(target.symbol.name)) throw new Error('Numeric LLVM identifiers have structural numbering and cannot be renamed.');
    return target;
  };
  const rename = {
    prepareRename(document, position) {
      const { symbol, token } = renameTarget(document, position);
      return { range: spanRange(document, token), placeholder: symbol.name.slice(1) };
    },
    provideRenameEdits(document, position, newName) {
      const { parsed, symbol } = renameTarget(document, position);
      const sigil = symbol.name[0];
      let bare = newName;
      if (/^[%@!#]/.test(bare)) {
        if (bare[0] !== sigil) throw new Error(`The name must use the ${sigil} sigil.`);
        bare = bare.slice(1);
      }
      if (!/^(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|"(?:[^"\\\r\n\0]|\\[a-fA-F0-9]{2})*")$/.test(bare)) throw new Error('Use an LLVM identifier or a quoted name with hexadecimal escapes. Numeric names are not supported.');
      const replacement = sigil + bare;
      const collision = parsed.symbols.some(other => other !== symbol && other.scope === symbol.scope && canonicalName(other.name) === canonicalName(replacement) && canonicalName(other.name) !== canonicalName(symbol.name));
      if (collision) throw new Error('An LLVM symbol with this name already exists in the same scope.');
      const edits = new vscode.WorkspaceEdit();
      for (const span of analysis.references(parsed, symbol, true)) {
        const isLabelDefinition = symbol.kind === 'label' && span.start === symbol.start;
        edits.replace(document.uri, spanRange(document, span), isLabelDefinition ? bare : replacement);
      }
      return edits;
    }
  };
  const symbols = {
    provideDocumentSymbols(document) {
      const parsed = getAnalysis(document);
      const create = symbol => new vscode.DocumentSymbol(symbol.name,
        ['label', 'metadata', 'attribute'].includes(symbol.kind) || symbol.type === 'unknown' ? '' : symbol.type, symbolKind(symbol.kind),
        spanRange(document, { start: Math.min(symbol.fullStart, symbol.start), end: Math.max(symbol.fullEnd, symbol.end) }), spanRange(document, symbol));
      return parsed.symbols.filter(symbol => symbol.scope === null).map(symbol => {
        const result = create(symbol);
        if (symbol.kind === 'function') result.children = parsed.symbols.filter(child => child.scope === symbol.name && child.start >= symbol.fullStart && child.end <= symbol.fullEnd).map(create);
        return result;
      });
    }
  };
  const highlights = {
    provideDocumentHighlights(document, position) {
      const { parsed, symbol } = at(document, position);
      return symbol ? analysis.references(parsed, symbol, true).map(span => new vscode.DocumentHighlight(spanRange(document, span), span.start === symbol.start ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read)) : [];
    }
  };
  const formatting = {
    provideDocumentFormattingEdits(document, options) {
      const original = document.getText(), formatted = analysis.formatIR(original, options);
      return original === formatted ? [] : [vscode.TextEdit.replace(spanRange(document, { start: 0, end: original.length }), formatted)];
    }
  };
  const semanticEmitter = new vscode.EventEmitter();
  const semantic = {
    onDidChangeSemanticTokens: semanticEmitter.event,
    provideDocumentSemanticTokens(document) {
      const builder = new vscode.SemanticTokensBuilder();
      if (!config(document).get('semanticHighlighting.enabled', true)) return builder.build();
      const parsed = getAnalysis(document);
      let previousEnd = -1;
      for (const token of parsed.tokens) {
        if (token.start < previousEnd || token.kind === 'comment') continue;
        const symbol = analysis.symbolAt(parsed, token.start);
        if (!symbol || token.kind === 'string' && symbol.kind !== 'label') continue;
        const range = spanRange(document, token);
        if (range.start.line !== range.end.line || range.start.character === range.end.character) continue;
        builder.push(range.start.line, range.start.character, range.end.character - range.start.character, semanticKinds[symbol.kind], 0);
        previousEnd = token.end;
      }
      return builder.build();
    }
  };
  const folding = {
    provideFoldingRanges(document) {
      const parsed = getAnalysis(document);
      const ranges = parsed.functions.filter(fn => !fn.symbol.declaration).flatMap(fn => {
        const start = document.positionAt(fn.bodyStart).line, end = document.positionAt(fn.bodyEnd).line - 1;
        return end > start ? [new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region)] : [];
      });
      const lines = parsed.text.split(/\r?\n/);
      const labels = parsed.symbols.filter(symbol => symbol.kind === 'label').sort((left, right) => left.start - right.start);
      for (const fn of parsed.functions) {
        if (fn.symbol.declaration) continue;
        const blocks = labels.filter(label => label.start >= fn.bodyStart && label.start < fn.bodyEnd);
        for (let index = 0; index < blocks.length; index++) {
          const start = document.positionAt(blocks[index].start).line;
          // The next label and the function's closing brace must stay visible.
          let end = document.positionAt(blocks[index + 1]?.start ?? fn.bodyEnd).line - 1;
          while (end > start && /^\s*$/.test(lines[end])) end--;
          if (end > start) ranges.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
        }
      }
      const regions = [];
      for (const token of parsed.tokens) {
        if (token.kind !== 'comment') continue;
        const position = document.positionAt(token.start);
        const lineStart = document.offsetAt(new vscode.Position(position.line, 0));
        if (!/^\s*$/.test(parsed.text.slice(lineStart, token.start))) continue;
        if (/^;\s*#?region\b/.test(token.text)) regions.push(position.line);
        else if (/^;\s*#?endregion\b/.test(token.text) && regions.length) {
          const start = regions.pop();
          if (position.line > start) ranges.push(new vscode.FoldingRange(start, position.line, vscode.FoldingRangeKind.Region));
        }
      }
      return ranges.sort((left, right) => left.start - right.start || right.end - left.end)
        .filter((range, index, sorted) => !index || range.start !== sorted[index - 1].start || range.end !== sorted[index - 1].end);
    }
  };
  const inlayEmitter = new vscode.EventEmitter();
  const inlays = {
    onDidChangeInlayHints: inlayEmitter.event,
    provideInlayHints(document, range) {
      const settings = config(document);
      if (!settings.get('inlayHints.enabled', true)) return [];
      const parsed = getAnalysis(document);
      const hints = settings.get('inlayHints.parameterNames', true) ? parameterHints(document, parsed, range, settings) : [];
      if (settings.get('inlayHints.predecessors', true)) hints.push(...predecessorHints(document, parsed, range));
      return hints.concat(parsed.symbols.filter(symbol => range.contains(document.positionAt(symbol.end))).flatMap(symbol => {
        const target = (symbol.kind === 'variable' || symbol.kind === 'parameter') && pointee(symbol);
        // SSA values always get `: type`; parameters already spell their type, so only pointers
        // with a known pointee get one. Either way, `→ pointee` follows a pointer type.
        const label = symbol.kind === 'variable' && symbol.type !== 'unknown' || symbol.kind === 'parameter' && target
          ? `: ${symbol.type}${target ? ` → ${target}` : ''}` : undefined;
        if (!label) return [];
        const hint = new vscode.InlayHint(document.positionAt(symbol.end), label, vscode.InlayHintKind.Type);
        hint.paddingLeft = true;
        if (target) hint.tooltip = markdown().appendMarkdown(pointerNotes(symbol).join('\n\n'));
        return [hint];
      }));
    }
  };
  // `name:` before each call argument, from the callee's parameter names or,
  // for unnamed library declarations, the documented ones.
  function parameterHints(document, parsed, range, settings) {
    const hints = [];
    for (const call of analysis.callArguments(parsed)) {
      const entry = settings.get('libraryHelp.enabled', true) && lookupLibrary(call.symbol.name, call.symbol);
      const documented = entry ? libraryParameters(entry, call.symbol) : [];
      call.args.forEach((argument, i) => {
        const parameter = call.symbol.parameters?.[i];
        const name = parameter?.name && !/^%\d+$/.test(parameter.name) ? parameter.name.slice(1) : parameter && documented[i]?.name.split(' ')[0];
        const position = document.positionAt(argument.start);
        // A same-named argument already says what the hint would.
        if (!name || argument.value?.slice(1) === name || !range.contains(position)) return;
        const hint = new vscode.InlayHint(position, `${name}:`, vscode.InlayHintKind.Parameter);
        hint.paddingRight = true;
        hints.push(hint);
      });
    }
    return hints;
  }
  // `preds: %a, %b` after each block label, as clang prints in a comment; each
  // name links to that block.
  function predecessorHints(document, parsed, range) {
    const hints = [];
    for (const fn of parsed.functions) {
      if (fn.symbol.declaration || fn.bodyStart >= fn.bodyEnd) continue;
      const graph = analysis.blockGraph(parsed, fn.bodyStart);
      for (const block of graph?.blocks || []) {
        if (!block.label || !block.predecessors.length) continue;
        // After the colon: the label symbol spans only the name.
        const after = block.label.fullEnd, end = parsed.text.slice(after).search(/\r|\n|$/) + after;
        const position = document.positionAt(after);
        if (/;\s*preds\b/.test(parsed.text.slice(after, end)) || !range.contains(position)) continue;
        const parts = [new vscode.InlayHintLabelPart('preds: ')];
        block.predecessors.forEach((index, i) => {
          const source = graph.blocks[index];
          const part = new vscode.InlayHintLabelPart(source.name || 'unlabeled');
          if (source.label) part.location = new vscode.Location(document.uri, spanRange(document, source.label));
          if (i) parts.push(new vscode.InlayHintLabelPart(', '));
          parts.push(part);
        });
        const hint = new vscode.InlayHint(position, parts);
        hint.paddingLeft = true;
        hints.push(hint);
      }
    }
    return hints;
  }
  const lensEmitter = new vscode.EventEmitter();
  const lensDocuments = new WeakMap();
  const lenses = {
    onDidChangeCodeLenses: lensEmitter.event,
    provideCodeLenses(document) {
      const settings = config(document), parsed = getAnalysis(document);
      const lenses = settings.get('codeLens.references', true) ? parsed.symbols.filter(symbol => symbol.scope === null && ['function', 'global', 'type'].includes(symbol.kind)).map(symbol => {
        const lens = new vscode.CodeLens(spanRange(document, symbol));
        lensDocuments.set(lens, document);
        return lens;
      }) : [];
      // Already resolved: opening the graph needs no counting.
      if (settings.get('codeLens.controlFlowGraph', true)) for (const fn of parsed.functions) {
        if (fn.symbol.declaration || fn.bodyStart >= fn.bodyEnd) continue;
        lenses.push(new vscode.CodeLens(spanRange(document, fn.symbol), { title: 'Control-flow graph', command: 'llvmIR.showControlFlowGraph', arguments: [document.uri, fn.bodyStart] }));
      }
      return lenses;
    },
    // Counted on demand through the (possibly workspace-wide) reference provider.
    async resolveCodeLens(lens, cancellation) {
      if (lens.command) return lens;
      const document = lensDocuments.get(lens);
      const locations = document ? await references.provideReferences(document, lens.range.start, { includeDeclaration: false }, cancellation) || [] : [];
      lens.command = { title: `${locations.length} reference${locations.length === 1 ? '' : 's'}`, command: 'editor.action.showReferences',
        arguments: [document?.uri, lens.range.start, locations] };
      return lens;
    }
  };
  // Quick fixes for built-in checks, recomputed so they always match the current text.
  const codeActions = {
    provideCodeActions(document, range, context) {
      const from = document.offsetAt(range.start), to = document.offsetAt(range.end);
      const actions = [];
      for (const issue of checkIR(getAnalysis(document))) {
        if (issue.end < from || issue.start > to) continue;
        const target = spanRange(document, issue);
        const diagnostics = (context?.diagnostics || []).filter(diagnostic => diagnostic.code === issue.code && diagnostic.range.start.line === target.start.line && diagnostic.range.start.character === target.start.character);
        const action = (title, apply) => {
          const result = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          result.edit = new vscode.WorkspaceEdit();
          apply(result.edit);
          result.diagnostics = diagnostics;
          result.isPreferred = true;
          actions.push(result);
        };
        if (issue.replacement) action(`Change to ${issue.replacement}`, edit => edit.replace(document.uri, target, issue.replacement));
        if (issue.insert) action(`Spell the function type ${issue.insert.text.trim()}`, edit => edit.insert(document.uri, document.positionAt(issue.insert.offset), issue.insert.text));
      }
      return actions;
    }
  };
  const providers = { hover, completion, signatures, definition, references, rename, symbols, highlights, formatting, semantic, folding, inlays, lenses, codeActions, analyze: getAnalysis,
    refresh() { semanticEmitter.fire(); inlayEmitter.fire(); lensEmitter.fire(); },
    dispose() { semanticEmitter.dispose(); inlayEmitter.dispose(); lensEmitter.dispose(); cache.clear(); } };
  return workspace ? attachWorkspaceProviders(vscode, providers, workspace, { markdown, paragraph, symbolDocumentation, signatureLabel }) : providers;
}

function createVerificationManager(collection, output, verifier = verifyIR, { onIssues, onResult } = {}) {
  const states = new Map();
  // Bumped whenever a file's published llvm-as results may become stale, so a
  // workspace verification that finishes afterwards discards its result.
  const generations = new Map(), workspaceRuns = new Set();
  const bump = id => generations.set(id, (generations.get(id) || 0) + 1);
  const toDiagnostics = (issues, positionAt) => issues.map(issue => {
    const diagnostic = new vscode.Diagnostic(new vscode.Range(positionAt(issue.start), positionAt(issue.end)), issue.message, issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'llvm-as';
    return diagnostic;
  });
  // Built-in checks skip errors on these lines, which llvm-as already reports.
  const errorLines = (issues, positionAt) => new Set(issues.filter(issue => issue.severity !== 'warning').map(issue => positionAt(issue.start).line));
  let disposed = false;
  const keyFor = document => document.uri.toString();
  const cancel = document => {
    const state = states.get(keyFor(document));
    if (!state) return;
    clearTimeout(state.timer);
    state.controller?.abort();
    states.delete(keyFor(document));
  };
  const allowed = document => !disposed && !document.isClosed && document.languageId === 'llvm-ir' && vscode.workspace.isTrusted && config(document).get('diagnostics.enabled', true);
  const begin = document => {
    cancel(document);
    bump(keyFor(document));
    collection.delete(document.uri);
    onIssues?.(document.uri, undefined);
    if (!allowed(document)) return undefined;
    const state = { version: document.version, controller: new AbortController() };
    states.set(keyFor(document), state);
    return state;
  };
  const run = async (document, state, explicit) => {
    if (!state || states.get(keyFor(document)) !== state || !allowed(document)) return { issues: [], cancelled: true };
    const settings = config(document);
    let result;
    try {
      result = await verifier(document.getText(), { executable: settings.get('llvmAsPath', 'llvm-as'), timeoutMs: settings.get('diagnostics.timeout', 5000), signal: state.controller.signal });
    } catch {
      result = { issues: [], unavailable: 'LLVM verification failed unexpectedly.' };
    }
    if (disposed || states.get(keyFor(document)) !== state || document.version !== state.version || !allowed(document) || state.controller.signal.aborted) return { issues: [], cancelled: true };
    if (result.cancelled) return result;
    onResult?.(result, document.getText(), document.uri);
    if (result.unavailable) {
      // Compiler stderr can contain source text; keep logs and notifications generic.
      output.appendLine(`LLVM verification unavailable (${unavailableSummary(result)}). Check llvmIR.llvmAsPath, compiler compatibility, and the verification timeout.`);
      if (explicit) void vscode.window.showWarningMessage(`LLVM verification unavailable: ${unavailableSummary(result)}. See the LLVM IR Language Tools output.`);
    } else {
      const positionAt = offset => document.positionAt(offset);
      collection.set(document.uri, toDiagnostics(result.issues, positionAt));
      onIssues?.(document.uri, errorLines(result.issues, positionAt));
      if (explicit) void vscode.window.showInformationMessage(result.issues.length ? `LLVM verification reported ${result.issues.length} issue(s).` : 'LLVM IR verification succeeded.');
    }
    return result;
  };
  return {
    schedule(document, immediate = false) {
      if (document.languageId !== 'llvm-ir') return;
      const state = begin(document);
      if (!state) return;
      if (Buffer.byteLength(document.getText(), 'utf8') > 2 * 1024 * 1024) {
        output.appendLine('Automatic LLVM verification skipped: document exceeds 2 MiB. Use LLVM IR: Verify Document to verify explicitly.');
        return;
      }
      const delay = immediate ? 0 : Math.max(0, config(document).get('diagnostics.delay', 600));
      state.timer = setTimeout(() => { void run(document, state, false); }, delay);
    },
    verify(document) {
      if (!document || document.languageId !== 'llvm-ir') {
        void vscode.window.showInformationMessage('Open an LLVM IR document to verify.');
        return Promise.resolve({ issues: [], cancelled: true });
      }
      if (!vscode.workspace.isTrusted) void vscode.window.showWarningMessage('LLVM verification requires a trusted workspace.');
      else if (!config(document).get('diagnostics.enabled', true)) void vscode.window.showInformationMessage('LLVM verification is disabled in settings.');
      return run(document, begin(document), true);
    },
    close(document) { cancel(document); collection.delete(document.uri); onIssues?.(document.uri, undefined); },
    // Runs llvm-as on every indexed file, open ones from their editor text.
    // Unopened files are verified from their index snapshot; `isCurrent(entry)`
    // reports whether that snapshot still describes the file once llvm-as returns.
    async verifyAll(entries, { positions, progress, cancellation, isCurrent = () => true } = {}) {
      const summary = { checked: 0, failed: 0 };
      if (!vscode.workspace.isTrusted) return { ...summary, unavailable: 'LLVM verification requires a trusted workspace.' };
      const controller = new AbortController();
      workspaceRuns.add(controller);
      const listener = cancellation?.onCancellationRequested?.(() => controller.abort());
      const stopped = () => disposed || controller.signal.aborted || cancellation?.isCancellationRequested;
      try {
        const open = new Map(vscode.workspace.textDocuments.filter(document => document.languageId === 'llvm-ir' && !document.isClosed).map(document => [document.uri.toString(), document]));
        for (const entry of entries) {
          if (stopped()) return { ...summary, cancelled: true };
          const uri = vscode.Uri.parse(entry.uri), document = open.get(entry.uri);
          progress?.(uri);
          if (!config(uri).get('diagnostics.enabled', true)) continue;
          let result;
          if (document && !document.isClosed) {
            const state = begin(document);
            // Workspace cancellation also stops the open document's llvm-as.
            const abort = () => state?.controller.abort();
            controller.signal.addEventListener('abort', abort, { once: true });
            try { result = await run(document, state, false); } finally { controller.signal.removeEventListener('abort', abort); }
          } else {
            const settings = config(uri), generation = generations.get(entry.uri) || 0;
            try { result = await verifier(entry.text, { executable: settings.get('llvmAsPath', 'llvm-as'), timeoutMs: settings.get('diagnostics.timeout', 5000), signal: controller.signal }); }
            catch { result = { issues: [], unavailable: 'LLVM verification failed unexpectedly.', reason: 'failed' }; }
            if (stopped()) return { ...summary, cancelled: true };
            // The file changed, opened or was removed while llvm-as ran.
            const fresh = (generations.get(entry.uri) || 0) === generation && !states.has(entry.uri) && isCurrent(entry);
            if (!fresh) result = { issues: [], cancelled: true };
            else if (!result.cancelled) onResult?.(result, entry.text, uri);
            if (fresh && !result.unavailable && !result.cancelled) {
              const positionAt = positions(entry.text);
              collection.set(uri, toDiagnostics(result.issues, positionAt));
              onIssues?.(uri, errorLines(result.issues, positionAt));
            }
          }
          if (stopped()) return { ...summary, cancelled: true };
          if (result.unavailable) return { ...summary, unavailable: result.unavailable, reason: result.reason };
          if (result.cancelled) continue;
          summary.checked++;
          if (result.issues.some(issue => issue.severity !== 'warning')) summary.failed++;
        }
        return summary;
      } finally {
        workspaceRuns.delete(controller);
        listener?.dispose?.();
      }
    },
    // Workspace results for an unopened file are stale once it changes on disk.
    forget(uri) {
      const id = uri.toString();
      bump(id);
      if (!states.has(id)) { collection.delete(uri); onIssues?.(uri, undefined); }
    },
    dispose() {
      disposed = true;
      for (const state of states.values()) { clearTimeout(state.timer); state.controller.abort(); }
      for (const controller of workspaceRuns) controller.abort();
      states.clear(); workspaceRuns.clear();
      collection.clear();
    }
  };
}

// Default themes color labels like plain text (entity.name.label is #C8C8C8 in
// Dark Modern), which hides the block structure of IR. A contributed theme
// color gives labels a hue of their own that themes and users can override.
function createLabelDecorations(analyze) {
  const definitionStyle = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('llvmIR.labelForeground'), fontWeight: 'bold' });
  const referenceStyle = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('llvmIR.labelForeground') });
  const timers = new Map();
  const paint = editor => {
    const document = editor.document;
    if (document.languageId !== 'llvm-ir') return;
    const definitions = [], references = [];
    if (config(document).get('labels.highlight', true)) {
      const parsed = analyze(document);
      for (const token of parsed.tokens) {
        if (token.kind === 'comment') continue;
        const symbol = analysis.symbolAt(parsed, token.start);
        if (symbol?.kind !== 'label' || token.kind !== 'identifier' && token.start !== symbol.start) continue;
        (token.start === symbol.start ? definitions : references).push(spanRange(document, token));
      }
    }
    editor.setDecorations(definitionStyle, definitions);
    editor.setDecorations(referenceStyle, references);
  };
  const refresh = document => {
    for (const editor of vscode.window.visibleTextEditors) if (!document || editor.document === document) paint(editor);
  };
  return {
    paint, refresh,
    // Typing repaints after a pause; decorations track edits in between.
    schedule(document) {
      const id = document.uri.toString();
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); refresh(document); }, 150));
    },
    dispose() { for (const timer of timers.values()) clearTimeout(timer); definitionStyle.dispose(); referenceStyle.dispose(); }
  };
}

// The workspace index analyzes through this, reusing an editor analysis of the same text.
const sharedAnalyzer = cache => (text, uri) => {
  const entry = cache.get(uri);
  return entry?.text === text ? entry.value : analysis.analyze(text);
};

let active;
function activate(context) {
  if (active) active.dispose();
  const cache = new Map();
  const collection = vscode.languages.createDiagnosticCollection('llvm-ir');
  const output = vscode.window.createOutputChannel('LLVM IR Language Tools');
  const workspace = createWorkspaceService(vscode, output, new WorkspaceIndex({ analyze: sharedAnalyzer(cache) }));
  const status = createStatus(vscode, { workspace, output });
  const providers = createProviders(cache, workspace);
  const labels = createLabelDecorations(providers.analyze);
  const graphs = createGraphView(vscode, providers.analyze);
  const checks = createCheckManager(vscode, { collection: vscode.languages.createDiagnosticCollection('llvm-ir-checks'), analyze: providers.analyze, index: workspace.index });
  const verification = createVerificationManager(collection, output, verifyIR, { onIssues: (uri, lines) => checks.setCompilerIssues(uri, lines),
    onResult: (result, text, uri) => status.report(result, text, uri) });
  const isOpen = uri => vscode.workspace.textDocuments.some(document => !document.isClosed && document.uri.toString() === uri);
  const indexListener = workspace.index.onDidChange(uri => { if (!isOpen(uri)) verification.forget(vscode.Uri.parse(uri)); });
  const positions = text => positionsIn(vscode, text);
  const verifyWorkspace = async () => {
    await workspace.start(); await workspace.ready();
    const entries = workspace.index.documents();
    if (!entries.length) return void vscode.window.showInformationMessage('No LLVM IR files are indexed in this workspace.');
    const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying LLVM IR', cancellable: true }, (progress, cancellation) =>
      verification.verifyAll(entries, { positions, cancellation, isCurrent: entry => workspace.index.get(entry.uri) === entry,
        progress: uri => progress.report({ message: vscode.workspace.asRelativePath(uri), increment: 100 / entries.length }) }));
    if (summary.unavailable) void vscode.window.showWarningMessage(`${summary.reason ? unavailableSummary(summary) + '.' : summary.unavailable} Built-in checks still run; see Problems.`);
    else void vscode.window.showInformationMessage(`LLVM verification${summary.cancelled ? ' cancelled after' : ':'} ${summary.checked} file${summary.checked === 1 ? '' : 's'} checked, ${summary.failed} with errors.`);
    return summary;
  };
  const subscriptions = [providers, workspace, verification, checks, labels, graphs, status, indexListener, collection, output,
    vscode.commands.registerCommand('llvmIR.checkToolchain', () => status.check()),
    vscode.commands.registerCommand('llvmIR.showControlFlowGraph', (uri, offset) => graphs.show(uri instanceof vscode.Uri ? uri : undefined, Number.isInteger(offset) ? offset : undefined)),
    vscode.window.onDidChangeTextEditorSelection(event => graphs.follow(event.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => graphs.follow(editor)),
    vscode.window.onDidChangeVisibleTextEditors(editors => { for (const editor of editors) labels.paint(editor); }),
    vscode.languages.registerHoverProvider(selector, providers.hover),
    vscode.languages.registerCompletionItemProvider(selector, providers.completion, '@', '%'),
    vscode.languages.registerSignatureHelpProvider(selector, providers.signatures, '(', ','),
    vscode.languages.registerDefinitionProvider(selector, providers.definition),
    vscode.languages.registerReferenceProvider(selector, providers.references),
    vscode.languages.registerRenameProvider(selector, providers.rename),
    vscode.languages.registerDocumentSymbolProvider(selector, providers.symbols),
    vscode.languages.registerWorkspaceSymbolProvider(providers.workspaceSymbols),
    vscode.languages.registerDocumentHighlightProvider(selector, providers.highlights),
    vscode.languages.registerDocumentFormattingEditProvider(selector, providers.formatting),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, providers.semantic, new vscode.SemanticTokensLegend(tokenTypes, [])),
    vscode.languages.registerFoldingRangeProvider(selector, providers.folding),
    vscode.languages.registerInlayHintsProvider(selector, providers.inlays),
    vscode.languages.registerCodeLensProvider(selector, providers.lenses),
    vscode.languages.registerCodeActionsProvider(selector, providers.codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('llvmIR.verifyWorkspace', verifyWorkspace),
    vscode.commands.registerCommand('llvmIR.verify', () => verification.verify(vscode.window.activeTextEditor?.document)),
    vscode.commands.registerCommand('llvmIR.reindex', async () => { await workspace.start(); const scan = workspace.rescan(); status.render(); await scan; await workspace.ready(); status.render(); }),
    vscode.workspace.onDidOpenTextDocument(document => { verification.schedule(document); checks.schedule(document, true); }),
    vscode.workspace.onDidChangeTextDocument(event => { verification.schedule(event.document); checks.schedule(event.document); labels.schedule(event.document); graphs.changed(event.document); }),
    vscode.workspace.onDidSaveTextDocument(document => verification.schedule(document, true)),
    vscode.workspace.onDidCloseTextDocument(document => { verification.close(document); checks.close(document); cache.delete(document.uri.toString()); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { status.render(); for (const document of vscode.workspace.textDocuments) verification.schedule(document, true); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('llvmIR')) return;
      providers.refresh();
      checks.refresh();
      if (event.affectsConfiguration('llvmIR.llvmAsPath')) status.reset(); else status.schedule();
      labels.refresh();
      for (const document of vscode.workspace.textDocuments) verification.schedule(document);
    })
  ];
  let disposed = false;
  active = { dispose() { if (disposed) return; disposed = true; for (const subscription of subscriptions) subscription.dispose(); } };
  context.subscriptions.push(active);
  for (const document of vscode.workspace.textDocuments) { verification.schedule(document); checks.schedule(document, true); }
  labels.refresh();
  status.render();
  void workspace.start().then(() => workspace.ready()).then(() => status.render(), () => output.appendLine('Workspace indexing failed. Run LLVM IR: Reindex Workspace to retry.'));
  return { verify: document => verification.verify(document), verifyWorkspace };
}

function deactivate() { active?.dispose(); active = undefined; }

module.exports = { activate, deactivate, createProviders, createVerificationManager, createLabelDecorations };
