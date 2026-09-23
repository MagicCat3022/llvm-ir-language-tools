'use strict';

// Offsets always refer to the original text. Strings and comments remain in the
// token stream for hover/formatting, but are never searched for symbol names.
function lex(text) {
  const tokens = [];
  let i = 0;
  const quoted = () => {
    i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += Math.min(2, text.length - i); continue; }
      if (text[i++] === '"') break;
    }
  };
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i;
    let kind = 'punctuation';
    if (text[i] === ';') {
      kind = 'comment';
      while (i < text.length && !/[\r\n]/.test(text[i])) i++;
    } else if ('@%!#'.includes(text[i]) && (text[i + 1] === '"' || /[\w.$-]/.test(text[i + 1] || ''))) {
      kind = 'identifier'; i++;
      if (text[i] === '"') quoted();
      else while (i < text.length && /[\w.$-]/.test(text[i])) i++;
    } else if (text[i] === '"') { kind = 'string'; quoted(); }
    else if (/[a-zA-Z_$]/.test(text[i])) {
      kind = 'word';
      while (i < text.length && /[\w.$-]/.test(text[i])) i++;
    } else if (/[0-9]/.test(text[i]) || (text[i] === '-' && /[0-9]/.test(text[i + 1] || ''))) {
      kind = 'number'; i++;
      while (i < text.length && /[\w.+-]/.test(text[i])) i++;
    } else if (text.slice(i, i + 3) === '...') i += 3;
    else i++;
    tokens.push({ start, end: i, text: text.slice(start, i), kind });
  }
  return tokens;
}

const closeFor = { '(': ')', '[': ']', '{': '}', '<': '>' };
function matching(tokens, start, limit = tokens.length) {
  const stack = [];
  for (let i = start; i < limit; i++) {
    const word = tokens[i].text;
    if (closeFor[word]) stack.push(closeFor[word]);
    else if (stack.length && word === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

function splitTop(tokens, start = 0, end = tokens.length) {
  const parts = [];
  const stack = [];
  let begin = start;
  for (let i = start; i < end; i++) {
    const word = tokens[i].text;
    if (closeFor[word]) stack.push(closeFor[word]);
    else if (stack.length && word === stack[stack.length - 1]) stack.pop();
    else if (!stack.length && word === ',') { parts.push(tokens.slice(begin, i)); begin = i + 1; }
  }
  if (begin < end) parts.push(tokens.slice(begin, end));
  return parts;
}

const primitive = /^(?:void|half|bfloat|float|double|fp128|x86_fp80|ppc_fp128|x86_mmx|x86_amx|label|metadata|token|opaque|i\d+)$/;

function readType(tokens, start, typeOffsets, depth = 0) {
  if (depth > 80 || !tokens[start]) return undefined;
  let i = start;
  let type;
  const word = tokens[i].text;
  if (primitive.test(word) || word === 'ptr') { type = word; i++; }
  else if (word.startsWith('%') && tokens[i].kind === 'identifier') {
    type = word;
    if (typeOffsets) typeOffsets.add(tokens[i].start);
    i++;
  } else if (word === '[' || word === '<') {
    if (word === '<' && tokens[i + 1]?.text === '{') {
      const inner = readType(tokens, i + 1, typeOffsets, depth + 1);
      if (!inner || tokens[inner.next]?.text !== '>') return undefined;
      type = `<${inner.type}>`; i = inner.next + 1;
    } else {
      i++;
      let scalable = '';
      if (tokens[i]?.text === 'vscale' && tokens[i + 1]?.text === 'x') { scalable = 'vscale x '; i += 2; }
      const size = tokens[i]?.text;
      if (!/^\d+$/.test(size || '') || tokens[i + 1]?.text !== 'x') return undefined;
      const inner = readType(tokens, i + 2, typeOffsets, depth + 1);
      if (!inner || tokens[inner.next]?.text !== closeFor[word]) return undefined;
      type = `${word}${scalable}${size} x ${inner.type}${closeFor[word]}`; i = inner.next + 1;
    }
  } else if (word === '{') {
    const types = []; i++;
    while (tokens[i] && tokens[i].text !== '}') {
      const inner = readType(tokens, i, typeOffsets, depth + 1);
      if (!inner) return undefined;
      types.push(inner.type); i = inner.next;
      if (tokens[i]?.text === ',') i++;
      else if (tokens[i]?.text !== '}') return undefined;
    }
    if (tokens[i]?.text !== '}') return undefined;
    type = types.length ? `{ ${types.join(', ')} }` : '{}'; i++;
  } else return undefined;

  for (;;) {
    if (tokens[i]?.text === 'addrspace' && tokens[i + 1]?.text === '(' && tokens[i + 3]?.text === ')') {
      type += ` addrspace(${tokens[i + 2].text})`; i += 4;
    } else if (tokens[i]?.text === '*') { type += '*'; i++; }
    else if (tokens[i]?.text === '(') {
      const end = matching(tokens, i);
      if (end < 0) break;
      const params = splitTop(tokens, i + 1, end);
      const types = [];
      let valid = true;
      for (const part of params) {
        if (part[0]?.text === '...') { types.push('...'); continue; }
        const param = readType(part, 0, typeOffsets, depth + 1);
        if (!param || param.next !== part.length) { valid = false; break; }
        types.push(param.type);
      }
      if (!valid) break;
      type += ` (${types.join(', ')})`; i = end + 1;
    } else break;
  }
  return { type, next: i };
}

function firstType(tokens, start, typeOffsets) {
  for (let i = start; i < tokens.length; i++) {
    const result = readType(tokens, i, typeOffsets);
    if (result) return { ...result, index: i };
  }
  return undefined;
}

function parameterName(tokens, start, typeOffsets) {
  let name;
  for (let i = start; i < tokens.length; i++) {
    if (['byval', 'byref', 'sret', 'preallocated', 'inalloca', 'elementtype'].includes(tokens[i].text) && tokens[i + 1]?.text === '(') {
      readType(tokens, i + 2, typeOffsets);
    }
    if (closeFor[tokens[i].text]) {
      const end = matching(tokens, i);
      if (end < 0) break;
      i = end;
    } else if (tokens[i].kind === 'identifier' && tokens[i].text.startsWith('%')) name = tokens[i];
  }
  return name;
}

function symbol(nameToken, kind, type, scope, text, fullStart, fullEnd) {
  return {
    name: nameToken.text, kind, type: type || 'unknown', scope,
    start: nameToken.start, end: nameToken.end, fullStart, fullEnd,
    definition: text.slice(fullStart, fullEnd).trim()
  };
}

const operations = new Set(('ret br switch indirectbr invoke callbr resume catchswitch catchret cleanupret unreachable ' +
  'fneg add fadd sub fsub mul fmul udiv sdiv fdiv urem srem frem shl lshr ashr and or xor ' +
  'extractelement insertelement shufflevector extractvalue insertvalue alloca load store fence cmpxchg atomicrmw getelementptr ' +
  'trunc zext sext fptrunc fpext fptoui fptosi uitofp sitofp ptrtoint inttoptr bitcast addrspacecast ' +
  'icmp fcmp phi select freeze call va_arg landingpad catchpad cleanuppad tail musttail notail').split(' '));

function lineEnd(text, position) {
  const end = text.slice(position).search(/[\r\n]/);
  return end < 0 ? text.length : position + end;
}

function analyze(text) {
  const tokens = lex(text);
  // String tokens are needed here only to recognize quoted basic-block labels.
  const code = tokens.filter(token => token.kind !== 'comment');
  const symbols = [], functions = [], statements = [], calls = [];
  const typeOffsets = new Set();
  const definitions = new Map();
  const add = entry => { symbols.push(entry); definitions.set(entry.start, entry); return entry; };

  for (let i = 0; i < code.length; i++) {
    const token = code[i];
    if (token.text === 'define' || token.text === 'declare') {
      const declaration = token.text === 'declare';
      let nameIndex = i + 1;
      while (nameIndex < code.length && !code[nameIndex].text.startsWith('@') && !['define', 'declare'].includes(code[nameIndex].text)) nameIndex++;
      if (!code[nameIndex]?.text.startsWith('@') || code[nameIndex + 1]?.text !== '(') continue;
      const open = nameIndex + 1;
      const close = matching(code, open);
      if (close < 0) continue;
      // The return type ends at the name; attributes such as range(i32 0, 10) precede it.
      const header = code.slice(i + 1, nameIndex);
      let returnInfo;
      for (let j = header.length - 1; j >= 0 && !returnInfo; j--) {
        const candidate = readType(header, j);
        if (candidate?.next === header.length && !closeFor[header[j - 1]?.text]) returnInfo = readType(header, j, typeOffsets);
      }
      returnInfo ||= firstType(header, 0, typeOffsets);
      const returnType = returnInfo?.type || 'unknown';
      const parameters = [];
      let variadic = false;
      for (const part of splitTop(code, open + 1, close)) {
        if (part[0]?.text === '...') { variadic = true; continue; }
        const info = firstType(part, 0, typeOffsets);
        const name = info && parameterName(part, info.next, typeOffsets);
        if (!part.length) continue;
        parameters.push({ name: name?.text || '', type: info?.type || 'unknown', start: name?.start ?? part[0].start, end: name?.end ?? part[part.length - 1].end });
      }
      let bodyOpen = -1, bodyClose = -1;
      let end = lineEnd(text, code[close].end);
      if (!declaration) {
        for (let j = close + 1; j < code.length; j++) {
          if (['define', 'declare'].includes(code[j].text)) break;
          if (code[j].text === '{') { bodyOpen = j; break; }
        }
        if (bodyOpen >= 0) { bodyClose = matching(code, bodyOpen); end = bodyClose >= 0 ? code[bodyClose].end : text.length; }
      }
      const functionSymbol = add(symbol(code[nameIndex], 'function', `${returnType} (${parameters.map(param => param.type).concat(variadic ? ['...'] : []).join(', ')})`, null, text, token.start, end));
      Object.assign(functionSymbol, { parameters, returnType, variadic, declaration });
      functionSymbol.definition = text.slice(token.start, bodyOpen >= 0 ? code[bodyOpen].start : end).trim();
      const fn = { name: functionSymbol.name, start: token.start, end, bodyStart: bodyOpen >= 0 ? code[bodyOpen].end : end, bodyEnd: bodyClose >= 0 ? code[bodyClose].start : end, symbol: functionSymbol,
        open: bodyOpen >= 0 ? code[bodyOpen] : undefined, unclosed: bodyOpen >= 0 && bodyClose < 0, headerEnd: code[close].end,
        parametersStart: code[open].end, parametersEnd: code[close].start };
      functions.push(fn);
      for (const parameter of parameters) {
        if (!parameter.name) continue;
        add(symbol({ text: parameter.name, start: parameter.start, end: parameter.end }, 'parameter', parameter.type, fn.name, text, parameter.start, parameter.end));
        symbols[symbols.length - 1].definition = `${parameter.type} ${parameter.name}`;
      }
      if (bodyOpen >= 0) {
        const stop = bodyClose >= 0 ? bodyClose : code.length;
        const starts = [];
        for (let j = bodyOpen + 1; j < stop; j++) {
          const current = code[j];
          const atLineStart = j === bodyOpen + 1 || /[\r\n]/.test(text.slice(code[j - 1].end, current.start));
          const isLabel = code[j + 1]?.text === ':' && ['word', 'number', 'string'].includes(current.kind);
          const assignment = current.text.startsWith('%') && code[j + 1]?.text === '=';
          if (isLabel) {
            const label = add(symbol(current, 'label', 'label', fn.name, text, current.start, code[j + 1].end));
            label.name = `%${current.text}`;
            starts.push({ index: j, label: true });
          } else if (atLineStart && /^#dbg_/.test(current.text)) {
            // Debug records (#dbg_value, …) sit between instructions without being one.
            starts.push({ index: j, label: true });
          } else if (assignment || (atLineStart && operations.has(current.text))) starts.push({ index: j, label: false });
        }
        for (let j = 0; j < starts.length; j++) {
          if (starts[j].label) continue;
          const begin = starts[j].index;
          const finish = starts[j + 1]?.index ?? stop;
          const parts = code.slice(begin, finish);
          const assignment = parts[0]?.text.startsWith('%') && parts[1]?.text === '=';
          let entry;
          if (assignment) entry = add(symbol(parts[0], 'variable', 'unknown', fn.name, text, parts[0].start, parts[parts.length - 1].end));
          statements.push({ tokens: assignment ? parts.slice(2) : parts, symbol: entry, fn });
        }
        i = bodyClose >= 0 ? bodyClose : code.length;
      } else i = close;
      continue;
    }
    if (token.kind === 'identifier' && code[i + 1]?.text === '=' && !definitions.has(token.start)) {
      const end = lineEnd(text, token.end);
      let j = i + 2;
      while (j < code.length && code[j].start < end && !['global', 'constant', 'type', 'alias', 'ifunc'].includes(code[j].text)) j++;
      let kind = token.text[0] === '%' ? 'type' : token.text[0] === '!' ? 'metadata' : token.text[0] === '#' ? 'attribute' : 'global';
      const info = j < code.length && code[j].start < end ? readType(code, j + 1, typeOffsets) : undefined;
      add(symbol(token, kind, info?.type || (kind === 'metadata' ? 'metadata' : 'unknown'), null, text, token.start, end));
    }
    if (token.text === 'attributes' && code[i + 1]?.text.startsWith('#')) {
      add(symbol(code[i + 1], 'attribute', 'unknown', null, text, token.start, lineEnd(text, token.end)));
    }
  }

  const analysis = { text, tokens, symbols, functions };
  const blockaddressTargets = new Map();
  for (let index = 0; index < code.length; index++) {
    if (code[index].text === 'blockaddress' && code[index + 1]?.text === '(' &&
        code[index + 2]?.text.startsWith('@') && code[index + 3]?.text === ',' &&
        code[index + 4]?.text.startsWith('%')) {
      blockaddressTargets.set(code[index + 4].start, code[index + 2].text);
    }
  }
  // Internal indexes are non-enumerable so the public model stays serializable.
  Object.defineProperty(analysis, '_index', { value: { code, typeOffsets, definitions, calls, blockaddressTargets, statements, blocks: new Map() } });
  for (const statement of statements) {
    const type = infer(statement.tokens, analysis, calls, typeOffsets);
    statement.type = type;
    if (statement.symbol) {
      statement.symbol.type = type;
      if (statement.tokens[0]?.text === 'alloca') {
        statement.symbol.allocatedType = firstType(statement.tokens, 1, typeOffsets)?.type;
      }
    }
  }
  inferPointerAccesses(analysis, statements);
  inferPointerValues(analysis, statements);
  return analysis;
}

function directValue(tokens) {
  const type = firstType(tokens, 0);
  const value = tokens[type?.next];
  return value?.kind === 'identifier' && type.next + 1 === tokens.length ? value : undefined;
}

// Resolves a `%name` token in a function to its unique local definition.
function localResolver(analysis) {
  const localValues = new Map();
  const key = (scope, name) => `${canonicalName(scope)}\0${canonicalName(name)}`;
  for (const item of analysis.symbols.filter(item => item.kind === 'variable' || item.kind === 'parameter')) {
    const id = key(item.scope, item.name);
    localValues.set(id, localValues.has(id) ? null : item);
  }
  return (scope, token) => token?.text?.startsWith('%') ? localValues.get(key(scope, token.text)) : undefined;
}

function inferPointerAccesses(analysis, statements) {
  const local = localResolver(analysis);
  const observations = new Map();
  const observe = (target, type, via) => {
    if (!target || !/^ptr(?: addrspace\(\d+\))?$/.test(target.type) || !type || type === 'ptr') return;
    if (!observations.has(target)) observations.set(target, new Map());
    observations.get(target).set(type, via);
  };
  const unique = target => {
    const entries = [...(observations.get(target) || [])];
    return entries.length === 1 ? { type: entries[0][0], via: entries[0][1] } : undefined;
  };

  // A GEP states the element type used for this access. With opaque pointers,
  // it does not establish an LLVM pointee type or a source-language class.
  for (const { tokens, fn } of statements) {
    if (tokens[0]?.text !== 'getelementptr') continue;
    const parts = splitTop(tokens, 1);
    const element = firstType(parts[0] || [], 0)?.type;
    const pointer = directValue(parts[1] || []);
    if (pointer) observe(local(fn.name, pointer), element);
  }

  // Propagate a callee parameter's observed GEP type to a direct argument.
  // Ambiguous definitions and indirect calls do not provide a useful hint.
  const definitions = new Map();
  for (const item of analysis.symbols.filter(item => item.kind === 'function' && !item.declaration)) {
    const id = canonicalName(item.name);
    definitions.set(id, definitions.has(id) ? null : item);
  }
  for (const { tokens, fn: caller } of statements) {
    const op = tokens.findIndex(token => ['call', 'invoke', 'callbr'].includes(token.text));
    if (op < 0) continue;
    const callee = tokens.findIndex((token, index) => index > op && token.kind === 'identifier' && token.text[0] === '@' && tokens[index + 1]?.text === '(');
    if (callee < 0) continue;
    const close = matching(tokens, callee + 1);
    if (close < 0) continue;
    const fn = definitions.get(canonicalName(tokens[callee].text));
    if (!fn) continue;
    const args = splitTop(tokens, callee + 2, close);
    for (let i = 0; i < Math.min(args.length, fn.parameters.length); i++) {
      const argument = directValue(args[i]);
      const parameter = local(fn.name, { text: fn.parameters[i].name });
      const access = unique(parameter);
      if (argument && access) observe(local(caller.name, argument), access.type, fn.name);
    }
  }

  for (const [target, types] of observations) {
    target.accessType = unique(target);
    if (types.size > 1) target.accessConflict = true;
  }

  // A stack slot containing one directly stored pointer can carry that
  // pointer's observed access type, provided the slot address never escapes.
  const allocations = new Map(analysis.symbols.filter(item => item.kind === 'variable' && /^ptr(?: addrspace\(\d+\))?$/.test(item.allocatedType || '')).map(item => [item, { writes: [], escaped: false }]));
  if (!allocations.size) return;
  for (const { tokens, fn } of statements) {
    const op = tokens[0]?.text;
    const parts = splitTop(tokens, 1);
    const allowed = new Set();
    if (op === 'store') {
      const destination = directValue(parts[1] || []);
      const allocation = local(fn.name, destination);
      if (allocations.has(allocation)) {
        allowed.add(destination.start);
        const value = directValue(parts[0] || []);
        allocations.get(allocation).writes.push(local(fn.name, value));
      }
    } else if (op === 'load') {
      const pointer = directValue(parts[1] || []);
      if (allocations.has(local(fn.name, pointer))) allowed.add(pointer.start);
    }
    for (const token of tokens) {
      const allocation = local(fn.name, token);
      if (allocations.has(allocation) && !allowed.has(token.start)) allocations.get(allocation).escaped = true;
    }
  }
  for (const [allocation, info] of allocations) {
    if (!info.escaped && info.writes.length === 1) allocation.storedPointerAccess = unique(info.writes[0]);
  }
}

const opaquePointer = type => /^ptr(?: addrspace\(\d+\))?$/.test(type || '');

// Follows pointers through GEP addresses, stack slots, object fields and
// constant tables (such as a vtable) where the module shows one possibility.
// Field values are hints: memory written other than by a direct store (memcpy,
// an escaped pointer, another module) is not observed.
function inferPointerValues(analysis, statements) {
  const local = localResolver(analysis);
  const globals = new Map(analysis.symbols.filter(item => item.kind === 'global').map(item => [canonicalName(item.name), item]));
  const pointerOperand = (fn, tokens) => {
    const token = directValue(tokens || []);
    return token?.text.startsWith('@') ? globals.get(canonicalName(token.text)) : local(fn.name, token);
  };
  const constantIndex = part => {
    const value = part[firstType(part, 0)?.next]?.text;
    return /^\d+$/.test(value || '') ? Number(value) : undefined;
  };
  // Offset-zero accesses through an object pointer read or write its first field.
  const fieldOf = target => target?.address?.field || (target?.accessType && memberType(analysis, target.accessType.type, 0)?.field
    ? { of: target.accessType.type, index: 0 } : undefined);
  const fieldKey = field => `${canonicalName(field.of)}\0${field.index}`;
  const tables = new Map();
  const tableElements = item => {
    if (!tables.has(item)) {
      const tokens = lex(item.definition || '');
      const keyword = tokens.findIndex(token => token.text === 'constant');
      const type = keyword >= 0 ? readType(tokens, keyword + 1) : undefined;
      const close = type && tokens[type.next]?.text === '[' ? matching(tokens, type.next) : -1;
      tables.set(item, close < 0 ? undefined : splitTop(tokens, type.next + 1, close).map(part => directValue(part)?.text));
    }
    return tables.get(item);
  };

  // A GEP result addresses the member selected by its indices.
  for (const { tokens, symbol } of statements) {
    if (!symbol || tokens[0]?.text !== 'getelementptr') continue;
    const parts = splitTop(tokens, 1);
    const indices = parts.slice(2).map(constantIndex);
    let type = firstType(parts[0] || [], 0)?.type, field;
    for (const index of indices.slice(1)) {
      const member = memberType(analysis, type, index);
      if (member?.field) field = { of: type, index };
      type = member?.type;
      if (!type) break;
    }
    if (type && indices.length) symbol.address = { type, ...(field ? { field } : {}), indices };
  }

  // A load from a stack slot yields the pointer stored there.
  for (const { tokens, symbol, fn } of statements) {
    if (!symbol || tokens[0]?.text !== 'load' || symbol.accessType || symbol.accessConflict) continue;
    const slot = pointerOperand(fn, splitTop(tokens, 1)[1]);
    if (slot?.storedPointerAccess) symbol.accessType = slot.storedPointerAccess;
  }

  const fieldValues = new Map();
  for (const { tokens, fn } of statements) {
    if (tokens[0]?.text !== 'store') continue;
    const parts = splitTop(tokens, 1);
    const field = fieldOf(pointerOperand(fn, parts[1]));
    if (!field) continue;
    const key = fieldKey(field);
    if (!fieldValues.has(key)) fieldValues.set(key, { field, values: new Map(), unknown: false });
    const value = directValue(parts[0] || []);
    if (value?.text.startsWith('@')) fieldValues.get(key).values.set(canonicalName(value.text), { value: value.text, via: fn.name });
    else fieldValues.get(key).unknown = true;
  }

  // A function in a constant table held by an object field (a vtable) is
  // likely called with such an object as its first argument.
  const receivers = new Map();
  for (const { field, values } of fieldValues.values()) {
    for (const { value } of values.values()) {
      const table = globals.get(canonicalName(value));
      for (const entry of (table && tableElements(table)) || []) {
        if (!entry?.startsWith('@')) continue;
        const id = canonicalName(entry);
        if (!receivers.has(id)) receivers.set(id, { types: new Map(), tables: new Map() });
        receivers.get(id).types.set(canonicalName(field.of), field.of);
        receivers.get(id).tables.set(canonicalName(table.name), table.name);
      }
    }
  }
  for (const fn of analysis.functions) {
    const first = fn.symbol.parameters[0];
    const parameter = first && opaquePointer(first.type) ? local(fn.name, { text: first.name }) : undefined;
    const receiver = receivers.get(canonicalName(fn.name));
    if (parameter && receiver && !parameter.accessType && !parameter.accessConflict)
      parameter.receiverHint = { types: [...receiver.types.values()], tables: [...receiver.tables.values()] };
  }

  // Source order visits definitions before same-function uses.
  for (const { tokens, symbol, fn } of statements) {
    if (!symbol) continue;
    const parts = splitTop(tokens, 1);
    if (tokens[0]?.text === 'getelementptr' && symbol.address) {
      const base = pointerOperand(fn, parts[1]);
      const table = base?.kind === 'global' ? { item: base, hint: false }
        : base?.valueHint && { item: globals.get(canonicalName(base.valueHint.value)), hint: true };
      const tableType = table?.item?.type;
      const { indices } = symbol.address;
      // Either `T, ptr @t, i64 k` or `[N x T], ptr @t, i64 0, i64 k` for a `[N x T]` table.
      const index = indices.length === 1 && memberType(analysis, tableType, 0)?.type === symbol.address.type ? indices[0]
        : indices.length === 2 && indices[0] === 0 && firstType(parts[0] || [], 0)?.type === tableType ? indices[1] : undefined;
      if (index !== undefined && tableElements(table.item)?.[index] !== undefined)
        symbol.address.table = { global: table.item.name, index, hint: table.hint, ...(table.hint ? { base: base.name } : {}) };
    } else if (tokens[0]?.text === 'load' && opaquePointer(symbol.type)) {
      const pointer = pointerOperand(fn, parts[1]);
      const table = pointer?.address?.table;
      const field = fieldOf(pointer);
      const stored = field && fieldValues.get(fieldKey(field));
      if (table) {
        const value = tableElements(globals.get(canonicalName(table.global)))[table.index];
        if (value?.startsWith('@')) symbol.valueHint = { value, table: { global: table.global, index: table.index }, hint: table.hint };
      } else if (stored && !stored.unknown && stored.values.size === 1) {
        const [{ value, via }] = stored.values.values();
        symbol.valueHint = { value, field, via, hint: true };
      }
    }
  }
}

function infer(tokens, analysis, calls, typeOffsets) {
  let opIndex = 0;
  while (['tail', 'musttail', 'notail'].includes(tokens[opIndex]?.text)) opIndex++;
  const op = tokens[opIndex]?.text;
  const rest = tokens.slice(opIndex + 1);
  const info = () => firstType(rest, 0, typeOffsets);
  const typedParts = () => splitTop(rest).map(part => firstType(part, 0, typeOffsets));
  const same = new Set('fneg add fadd sub fsub mul fmul udiv sdiv fdiv urem srem frem shl lshr ashr and or xor phi freeze load va_arg landingpad'.split(' '));
  if (same.has(op)) {
    if (op === 'load' || op === 'va_arg') {
      const parts = typedParts();
      return (op === 'va_arg' ? parts[1] : parts[0])?.type || 'unknown';
    }
    return info()?.type || 'unknown';
  }
  if (op === 'icmp' || op === 'fcmp') {
    const operand = info()?.type;
    const vector = operand?.match(/^<(vscale x )?(\d+) x /);
    return vector ? `<${vector[1] || ''}${vector[2]} x i1>` : 'i1';
  }
  if (op === 'alloca') {
    info();
    const address = rest.findIndex(item => item.text === 'addrspace');
    return address >= 0 && rest[address + 2] ? `ptr addrspace(${rest[address + 2].text})` : 'ptr';
  }
  if (op === 'getelementptr') {
    const parts = typedParts();
    const pointer = parts[1]?.type;
    if (!pointer) return 'unknown';
    const vector = pointer.match(/^<(vscale x )?(\d+) x (ptr(?: addrspace\(\d+\))?)>$/);
    if (vector) return pointer;
    if (/^ptr(?: addrspace\(\d+\))?$/.test(pointer)) {
      const vectorIndex = parts.slice(2).find(part => /^</.test(part?.type || ''))?.type.match(/^<(vscale x )?(\d+) x /);
      return vectorIndex ? `<${vectorIndex[1] || ''}${vectorIndex[2]} x ${pointer}>` : pointer;
    }
    // Typed-pointer GEP needs the indexed pointee type, which is intentionally
    // not guessed from an opaque pointer.
    return 'unknown';
  }
  if (new Set('trunc zext sext fptrunc fpext fptoui fptosi uitofp sitofp ptrtoint inttoptr bitcast addrspacecast'.split(' ')).has(op)) {
    info();
    const to = rest.findIndex(token => token.text === 'to');
    return to >= 0 ? readType(rest, to + 1, typeOffsets)?.type || 'unknown' : 'unknown';
  }
  if (op === 'call' || op === 'invoke' || op === 'callbr') {
    let callee = -1;
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i].kind === 'identifier' && ['@', '%'].includes(rest[i].text[0]) && rest[i + 1].text === '(') { callee = i; break; }
    }
    const returnInfo = firstType(callee >= 0 ? rest.slice(0, callee) : rest, 0, typeOffsets);
    if (callee >= 0) {
      const close = matching(rest, callee + 1);
      const end = close >= 0 ? rest[close].end : tokens[tokens.length - 1].end;
      for (const part of splitTop(rest, callee + 2, close >= 0 ? close : rest.length)) {
        const argument = firstType(part, 0, typeOffsets);
        if (argument) parameterName(part, argument.next, typeOffsets);
      }
      calls.push({ name: rest[callee].text, calleeOffset: rest[callee].start, open: rest[callee + 1].end, start: tokens[opIndex].start, end, incomplete: close < 0, args: rest.slice(callee + 2, close >= 0 ? close : rest.length) });
    }
    // A call may spell an explicit function type: call i32(i32) @f(...).
    if (returnInfo) {
      const before = callee >= 0 ? rest.slice(0, callee) : rest;
      const base = readType(before.slice(0, returnInfo.next).filter((token, i) => i < returnInfo.next), returnInfo.index, typeOffsets);
      return (base?.type || returnInfo.type).replace(/ \([^]*\)$/, '');
    }
    return 'unknown';
  }
  if (op === 'select') return typedParts()[1]?.type || 'unknown';
  if (op === 'extractelement') {
    const vector = info()?.type;
    return vector?.match(/^<(?:vscale x )?\d+ x (.+)>$/)?.[1] || 'unknown';
  }
  if (op === 'insertelement') { const parts = typedParts(); return parts[0]?.type || 'unknown'; }
  if (op === 'shufflevector') {
    const parts = typedParts();
    const element = parts[0]?.type.match(/^<(?:vscale x )?\d+ x (.+)>$/)?.[1];
    const shape = parts[2]?.type.match(/^<(vscale x )?(\d+) x /);
    return element && shape ? `<${shape[1] || ''}${shape[2]} x ${element}>` : 'unknown';
  }
  if (op === 'extractvalue' || op === 'insertvalue') {
    const parts = splitTop(rest);
    const aggregate = firstType(parts[0] || [], 0, typeOffsets);
    if (op === 'insertvalue') { firstType(parts[1] || [], 0, typeOffsets); return aggregate?.type || 'unknown'; }
    let type = aggregate?.type || 'unknown';
    for (const indexPart of parts.slice(1)) {
      if (!/^\d+$/.test(indexPart[0]?.text || '')) return 'unknown';
      type = memberType(analysis, type, Number(indexPart[0].text))?.type || 'unknown';
    }
    return type;
  }
  if (op === 'cmpxchg') {
    const value = typedParts()[1]?.type;
    return value ? `{ ${value}, i1 }` : 'unknown';
  }
  if (op === 'atomicrmw') return typedParts()[1]?.type || 'unknown';
  // Index types on non-result instructions too, for symbol identity.
  if (['ret', 'store', 'br', 'switch', 'indirectbr', 'resume'].includes(op)) typedParts();
  return 'unknown';
}

// Member `index` of an array or (packed) struct, resolving named types. Array
// elements do not need a constant index; struct fields do.
function memberType(analysis, type, index) {
  const visited = new Set();
  while (type?.startsWith('%') && !visited.has(type)) {
    visited.add(type);
    type = analysis.symbols.find(entry => entry.kind === 'type' && sameName(entry.name, type))?.type;
  }
  const inner = lex(type || '');
  if (inner[0]?.text === '[') return { type: readType(inner, 3)?.type };
  const start = inner[0]?.text === '<' ? 2 : 1;
  const end = inner[0]?.text === '<' ? inner.length - 2 : inner.length - 1;
  if (inner[start - 1]?.text !== '{' || !Number.isInteger(index)) return undefined;
  const field = readType(splitTop(inner, start, end)[index] || [], 0)?.type;
  return field && { type: field, field: true };
}

function tokenAt(analysis, offset) {
  if (!Number.isFinite(offset) || offset < 0) return undefined;
  let low = 0, high = analysis.tokens.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const token = analysis.tokens[middle];
    if (offset < token.start) high = middle - 1;
    else if (offset >= token.end) low = middle + 1;
    else return token;
  }
  return undefined;
}

// The function whose source span contains `offset`; functions are in source
// order and do not overlap.
function functionContaining(analysis, offset) {
  const functions = analysis.functions;
  let low = 0, high = functions.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (functions[middle].start <= offset) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  const fn = functions[found];
  return fn && offset < fn.end ? fn : undefined;
}

function scopeAt(analysis, offset) {
  const fn = functionContaining(analysis, offset);
  return fn && !fn.symbol.declaration ? fn.name : null;
}

// LLVM names are byte strings: literal UTF-8 and escaped hexadecimal bytes
// have the same identity. Bare numeric identifiers are slot numbers, whereas
// quoted numeric identifiers are names. Keep source spelling on public symbols.
// Names repeat heavily and decoding allocates, so identities are memoized.
const canonicalCache = new Map();
function canonicalName(name) {
  if (name === null) return null;
  let cached = canonicalCache.get(name);
  if (cached === undefined) {
    if (canonicalCache.size > 50000) canonicalCache.clear();
    canonicalCache.set(name, cached = decodeName(name));
  }
  return cached;
}
function decodeName(name) {
  const sigil = name[0];
  const spelling = name.slice(1);
  if (/^\d+$/.test(spelling)) return `${sigil}:slot:${spelling.replace(/^0+(?=\d)/, '')}`;
  if (!spelling.startsWith('"')) return `${sigil}:name:${Buffer.from(spelling, 'utf8').toString('hex')}`;
  if (!spelling.endsWith('"')) return `${sigil}:incomplete:${spelling}`;
  const content = spelling.slice(1, -1);
  const chunks = [];
  let previous = 0;
  for (const match of content.matchAll(/\\([0-9a-fA-F]{2})/g)) {
    chunks.push(Buffer.from(content.slice(previous, match.index), 'utf8'));
    chunks.push(Buffer.from([parseInt(match[1], 16)]));
    previous = match.index + match[0].length;
  }
  chunks.push(Buffer.from(content.slice(previous), 'utf8'));
  return `${sigil}:name:${Buffer.concat(chunks).toString('hex')}`;
}

function sameName(left, right) { return left === right || canonicalName(left) === canonicalName(right); }

function resolve(analysis, token) {
  if (!token) return undefined;
  const defined = analysis._index.definitions.get(token.start);
  if (defined) {
    if (defined.kind === 'function') return named(analysis, defined.name).find(entry => entry.kind === 'function' && entry.scope === null && !entry.declaration) || defined;
    return defined;
  }
  if (token.kind !== 'identifier') return undefined;
  // A blockaddress names the block in its explicit function operand, even in a
  // global initializer or in the body of a different function.
  const blockFunction = analysis._index.blockaddressTargets.get(token.start);
  if (blockFunction) return scoped(analysis, blockFunction, token.text).find(entry => entry.kind === 'label');
  const candidates = named(analysis, token.text);
  if (analysis._index.typeOffsets.has(token.start)) return candidates.find(entry => entry.kind === 'type');
  const scope = scopeAt(analysis, token.start);
  if (token.text[0] === '%' && scope) {
    const local = scoped(analysis, scope, token.text)[0];
    if (local) return local;
  }
  return candidates.find(entry => entry.scope === null && entry.kind === 'function' && !entry.declaration) || candidates.find(entry => entry.scope === null);
}

// Symbols by canonical name, built once per analysis.
function named(analysis, name) {
  let index = analysis._index.named;
  if (!index) {
    index = new Map();
    for (const entry of analysis.symbols) {
      const id = canonicalName(entry.name);
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(entry);
    }
    analysis._index.named = index;
  }
  return index.get(canonicalName(name)) || [];
}

// Symbols by function and canonical name, in source order. Clang reuses local
// names such as %0 and %this.addr in every function, so a lookup by name
// alone would scan one candidate per function.
function scoped(analysis, scope, name) {
  let index = analysis._index.scoped;
  if (!index) {
    index = new Map();
    for (const entry of analysis.symbols) {
      if (entry.scope === null) continue;
      const fn = canonicalName(entry.scope), id = canonicalName(entry.name);
      let names = index.get(fn);
      if (!names) index.set(fn, names = new Map());
      let entries = names.get(id);
      if (!entries) names.set(id, entries = []);
      entries.push(entry);
    }
    analysis._index.scoped = index;
  }
  return index.get(canonicalName(scope))?.get(canonicalName(name)) || [];
}

function symbolAt(analysis, offset) { return resolve(analysis, tokenAt(analysis, offset)); }

function references(analysis, target, includeDeclaration = true) {
  if (!target) return [];
  return analysis.tokens.filter(token => {
    if (!includeDeclaration && analysis._index.definitions.has(token.start)) return false;
    const entry = resolve(analysis, token);
    return entry && sameName(entry.name, target.name) && entry.kind === target.kind && sameName(entry.scope, target.scope);
  }).map(({ start, end }) => ({ start, end }));
}

function visibleSymbols(analysis, offset) {
  const scope = scopeAt(analysis, offset);
  const result = new Map();
  for (const entry of analysis.symbols) {
    if (entry.scope !== null && !sameName(entry.scope, scope)) continue;
    const key = `${canonicalName(entry.scope)}\0${entry.kind}\0${canonicalName(entry.name)}`;
    if (!result.has(key) || (entry.kind === 'function' && !entry.declaration)) result.set(key, entry);
  }
  return [...result.values()];
}

function callAt(analysis, offset) {
  const call = analysis._index.calls.find(entry => offset >= entry.open && (entry.incomplete ? offset <= entry.end || (offset > entry.end && /^\s*$/.test(analysis.text.slice(entry.end, offset)) && offset <= analysis.text.length) : offset < entry.end));
  if (!call) return undefined;
  const target = symbolAt(analysis, call.calleeOffset);
  if (target?.kind !== 'function') return undefined;
  let activeParameter = 0;
  const stack = [];
  for (const token of call.args) {
    if (token.start >= offset) break;
    if (closeFor[token.text]) stack.push(closeFor[token.text]);
    else if (stack.length && token.text === stack[stack.length - 1]) stack.pop();
    else if (!stack.length && token.text === ',') activeParameter++;
  }
  return { symbol: target, activeParameter, start: call.start, end: call.end };
}

// Call sites with their resolved callee and top-level argument spans.
function callArguments(analysis) {
  return analysis._index.calls.flatMap(call => {
    const target = symbolAt(analysis, call.calleeOffset);
    if (target?.kind !== 'function') return [];
    const args = splitTop(call.args).filter(part => part.length).map(part => ({ start: part[0].start, end: part[part.length - 1].end, value: part.length > 1 && part[part.length - 1].kind === 'identifier' ? part[part.length - 1].text : undefined }));
    return [{ symbol: target, args, start: call.start }];
  });
}

const terminators = new Set('ret br switch indirectbr invoke callbr resume catchswitch catchret cleanupret unreachable'.split(' '));
const opcodeIndex = tokens => { let i = 0; while (['tail', 'musttail', 'notail'].includes(tokens[i]?.text)) i++; return i; };
const statementStart = statement => statement.symbol?.start ?? statement.tokens[0]?.start;
const bodyAt = (analysis, offset) => analysis.functions.find(fn => !fn.symbol.declaration && fn.bodyStart < fn.bodyEnd && offset >= fn.bodyStart && offset <= fn.bodyEnd);

// Immediate dominators by Cooper, Harvey and Kennedy's iterative algorithm,
// with dominance queries answered in O(1) from dominator-tree intervals.
// Unreachable blocks are dominated by every block, as the verifier treats them.
function dominatorTree(count, predecessors) {
  const idom = new Array(count).fill(-1), order = new Array(count).fill(-1), postorder = [];
  if (count) {
    const successors = Array.from({ length: count }, () => []);
    predecessors.forEach((list, block) => { for (const p of list) successors[p].push(block); });
    const seen = new Uint8Array(count), stack = [[0, 0]];
    seen[0] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], next = successors[top[0]][top[1]++];
      if (next === undefined) { order[top[0]] = postorder.length; postorder.push(top[0]); stack.pop(); }
      else if (!seen[next]) { seen[next] = 1; stack.push([next, 0]); }
    }
    idom[0] = 0;
    const intersect = (a, b) => {
      while (a !== b) { while (order[a] < order[b]) a = idom[a]; while (order[b] < order[a]) b = idom[b]; }
      return a;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (let i = postorder.length - 2; i >= 0; i--) {
        const block = postorder[i];
        let next = -1;
        for (const p of predecessors[block]) if (order[p] >= 0 && idom[p] >= 0) next = next < 0 ? p : intersect(p, next);
        if (next >= 0 && idom[block] !== next) { idom[block] = next; changed = true; }
      }
    }
  }
  const children = Array.from({ length: count }, () => []);
  for (let i = 1; i < count; i++) if (idom[i] >= 0) children[idom[i]].push(i);
  const enter = new Int32Array(count).fill(-1), leave = new Int32Array(count).fill(-1);
  let clock = 0;
  if (count) for (const stack = [[0, 0]]; stack.length;) {
    const top = stack[stack.length - 1];
    if (!top[1]) enter[top[0]] = clock++;
    const child = children[top[0]][top[1]++];
    if (child === undefined) { leave[top[0]] = clock++; stack.pop(); } else stack.push([child, 0]);
  }
  const reachable = block => enter[block] >= 0;
  const dominators = Array.from({ length: count }, (_, block) => ({
    has: d => d >= 0 && d < count && (!reachable(block) || reachable(d) && enter[d] <= enter[block] && leave[block] <= leave[d]),
  }));
  if (count) idom[0] = -1;
  return { idom: idom.map(d => d < 0 ? undefined : d), dominators };
}

// Basic blocks and dominator sets of one function body. Blocks without
// predecessors are unreachable, where LLVM treats every value as dominating.
function controlFlow(analysis, fn) {
  const cached = analysis._index.blocks.get(fn);
  if (cached) return cached;
  // Group labels and statements by function once, not once per function.
  if (!analysis._index.members) {
    const members = analysis._index.members = new Map(analysis.functions.map(item => [item, { labels: [], statements: [] }]));
    for (const statement of analysis._index.statements) members.get(statement.fn)?.statements.push(statement);
    for (const entry of analysis.symbols) {
      if (entry.kind !== 'label') continue;
      const owner = functionContaining(analysis, entry.start);
      if (owner && entry.start >= owner.bodyStart && entry.start < owner.bodyEnd) members.get(owner).labels.push(entry);
    }
  }
  const { labels, statements } = analysis._index.members.get(fn) || { labels: [], statements: [] };
  const items = [...labels.map(label => ({ start: label.start, label })),
    ...statements.filter(statement => statementStart(statement) !== undefined).map(statement => ({ start: statementStart(statement), statement }))]
    .sort((left, right) => left.start - right.start);
  const blocks = [];
  let current;
  const open = (start, label) => blocks.push(current = { start, label, statements: [], successors: [], terminated: false });
  for (const item of items) {
    if (item.label) { open(item.start, item.label); continue; }
    if (!current || current.terminated) open(item.start, undefined);
    current.statements.push(item.statement);
    const tokens = item.statement.tokens;
    if (!terminators.has(tokens[opcodeIndex(tokens)]?.text)) continue;
    current.terminated = true;
    tokens.forEach((token, i) => { if (token.text === 'label' && tokens[i + 1]?.kind === 'identifier') current.successors.push(canonicalName(tokens[i + 1].text)); });
  }
  const byName = new Map(blocks.filter(block => block.label).map((block, _, all) => [canonicalName(block.label.name), blocks.indexOf(block)]));
  const predecessors = blocks.map(() => []);
  blocks.forEach((block, i) => { for (const name of block.successors) if (byName.has(name)) predecessors[byName.get(name)].push(i); });
  const { idom, dominators } = dominatorTree(blocks.length, predecessors);
  const result = { blocks, idom, dominators, blockAt(offset) { let index = 0; blocks.forEach((block, i) => { if (block.start <= offset) index = i; }); return index; } };
  analysis._index.blocks.set(fn, result);
  return result;
}

// The statement being edited at `offset`: the cursor is on its last line, or
// inside one of its open brackets (a multi-line switch table).
function enclosingStatement(analysis, fn, offset) {
  let found;
  for (const statement of analysis._index.statements) {
    if (statement.fn === fn && statementStart(statement) < offset) found = statement;
  }
  if (!found || analysis.symbols.some(entry => entry.kind === 'label' && entry.start > statementStart(found) && entry.start < offset)) return undefined;
  const before = found.tokens.filter(token => token.start < offset);
  const last = before[before.length - 1] || found.symbol;
  if (!last) return undefined;
  const stack = [];
  for (const token of before) {
    if (closeFor[token.text]) stack.push(closeFor[token.text]);
    else if (stack.length && token.text === stack[stack.length - 1]) stack.pop();
  }
  return stack.length || !/[\r\n]/.test(analysis.text.slice(last.end, offset)) ? found : undefined;
}

// Values usable as an operand at `offset`: parameters, and results whose
// definition dominates the statement. Phi operands flow in along edges, so
// any value of the function may appear there.
function availableValues(analysis, offset, statement) {
  const fn = bodyAt(analysis, offset);
  if (!fn) return [];
  if (statement === undefined) statement = enclosingStatement(analysis, fn, offset);
  const flow = controlFlow(analysis, fn);
  const at = statement ? statementStart(statement) : offset;
  const here = flow.blockAt(at);
  const phi = statement?.tokens[opcodeIndex(statement.tokens)]?.text === 'phi';
  const parameters = analysis.symbols.filter(entry => entry.kind === 'parameter' && sameName(entry.scope, fn.name));
  const values = flow.blocks.flatMap((block, index) => block.statements.filter(item => item.symbol && (phi ||
    flow.dominators[here].has(index) && (index !== here || item.symbol.start < at))).map(item => item.symbol));
  return [...parameters, ...values];
}

// The control-flow graph of the function containing `offset`, for hovers,
// inlay hints and the graph view. Blocks carry source spans, edges by index,
// immediate dominators, and the back edges that close loops.
function blockGraph(analysis, offset) {
  const fn = bodyAt(analysis, offset);
  if (!fn) return undefined;
  const flow = controlFlow(analysis, fn);
  const byName = new Map(flow.blocks.map((block, i) => [block.label && canonicalName(block.label.name), i]).filter(([name]) => name));
  const blocks = flow.blocks.map((block, i) => {
    const last = block.statements[block.statements.length - 1];
    const terminator = last?.tokens[opcodeIndex(last.tokens)]?.text;
    return { index: i, name: block.label?.name || (i ? undefined : '%entry'), label: block.label, start: block.start,
      end: flow.blocks[i + 1]?.start ?? fn.bodyEnd, instructions: block.statements.length, terminator: terminators.has(terminator) ? terminator : undefined,
      successors: [...new Set(block.successors.filter(name => byName.has(name)).map(name => byName.get(name)))], predecessors: [] };
  });
  for (const block of blocks) for (const next of block.successors) blocks[next].predecessors.push(block.index);
  const reached = new Set(blocks.length ? [0] : []), queue = [...reached];
  while (queue.length) for (const next of blocks[queue.shift()].successors) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  for (const block of blocks) {
    block.reachable = reached.has(block.index);
    if (!block.reachable) continue;
    // A back edge comes from a block this one dominates (a natural loop).
    block.idom = flow.idom[block.index];
    block.backEdges = block.predecessors.filter(p => reached.has(p) && flow.dominators[p].has(block.index));
  }
  return { fn, blocks, blockAt: position => blocks[flow.blockAt(position)] };
}

const icmpPredicates = 'eq ne ugt uge ult ule sgt sge slt sle'.split(' ');
const fcmpPredicates = 'oeq ogt oge olt ole one ord ueq ugt uge ult ule une uno true false'.split(' ');
const compareFlags = { icmp: new Set(['samesign']), fcmp: new Set('nnan ninf nsz arcp contract afn reassoc fast'.split(' ')) };
const binary = new Set('add fadd sub fsub mul fmul udiv sdiv fdiv urem srem frem shl lshr ashr and or xor icmp fcmp'.split(' '));
// Instructions whose first type describes the result or memory, not an operand.
const leadingResultType = new Set('alloca load getelementptr phi call invoke callbr va_arg landingpad'.split(' '));

// What belongs at the cursor inside a function body: a block label, a
// comparison predicate, or a value of an expected type (undefined if unknown).
// Where a type or a parameter attribute can follow in a define/declare parameter list.
const parameterTypes = 'i1 i8 i16 i32 i64 i128 ptr half bfloat float double fp128 x86_fp80 ppc_fp128 metadata'.split(' ');
const parameterAttributes = 'noundef nonnull noalias nocapture captures readonly writeonly readnone signext zeroext inreg byval byref sret align dereferenceable dereferenceable_or_null returned immarg inalloca preallocated elementtype nest swiftself swifterror'.split(' ');

// Completion in a function header's parameter list: a type starts each
// parameter; after it come attributes and a new name, never existing values.
function parameterContext(analysis, offset, prefixStart) {
  const fn = analysis.functions.find(item => item.parametersStart !== undefined && prefixStart >= item.parametersStart && offset <= item.parametersEnd);
  if (!fn) return undefined;
  const code = analysis._index.code;
  let low = 0, high = code.length;
  while (low < high) { const middle = (low + high) >>> 1; if (code[middle].start < fn.parametersStart) low = middle + 1; else high = middle; }
  let current = [];
  const stack = [];
  for (let i = low; i < code.length; i++) {
    const token = code[i];
    if (token.start >= prefixStart) break;
    if (closeFor[token.text]) stack.push(closeFor[token.text]);
    else if (stack.length && token.text === stack[stack.length - 1]) stack.pop();
    else if (!stack.length && token.text === ',') { current = []; continue; }
    current.push(token);
  }
  if (!current.length) return { kind: 'parameter', expect: 'type', types: parameterTypes, named: analysis.symbols.filter(symbol => symbol.kind === 'type') };
  const type = readType(current, 0);
  return type && type.next <= current.length ? { kind: 'parameter', expect: 'attribute', attributes: parameterAttributes } : undefined;
}

function completionContext(analysis, offset, prefixStart = offset) {
  const header = parameterContext(analysis, offset, prefixStart);
  if (header) return header;
  const fn = bodyAt(analysis, offset);
  const statement = fn && enclosingStatement(analysis, fn, prefixStart);
  if (!statement) return undefined;
  const before = statement.tokens.filter(token => token.start < prefixStart);
  const op = opcodeIndex(before);
  if (op >= before.length) return undefined;
  const opcode = before[op].text, last = before[before.length - 1];
  const flow = controlFlow(analysis, fn);
  const labels = () => ({ kind: 'label', labels: flow.blocks.slice(1).filter(block => block.label).map(block => block.label) });
  const value = (expectedType, extra) => ({ kind: 'value', expectedType, values: availableValues(analysis, offset, statement), ...extra });
  if (last.text === 'label') return labels();
  // Switch cases are constants, not SSA values.
  if (opcode === 'switch' && before.some(token => token.text === '[')) return undefined;
  if (compareFlags[opcode] && before.slice(op + 1).every(token => compareFlags[opcode].has(token.text)))
    return { kind: 'predicate', predicates: opcode === 'icmp' ? icmpPredicates : fcmpPredicates };
  if (opcode === 'phi') {
    const open = before.map(token => token.text).lastIndexOf('[');
    if (open > before.map(token => token.text).lastIndexOf(']')) {
      return before.slice(open + 1).some(token => token.text === ',') ? labels() : value(firstType(before, op + 1)?.type);
    }
  }
  const call = ['call', 'invoke', 'callbr'].includes(opcode) && callAt(analysis, prefixStart);
  let from = op + 1;
  if (call) {
    const commas = before.map(token => token.text).lastIndexOf(',');
    from = Math.max(commas, before.findIndex(token => token.end === analysis._index.calls.find(entry => entry.start === call.start)?.open)) + 1;
    if (from >= before.length) {
      const parameter = call.symbol.parameters?.[call.activeParameter];
      return value(parameter?.type, parameter && { typed: true });
    }
  }
  for (let i = from; i < before.length; i++) {
    if (readType(before, i)?.next !== before.length) continue;
    const resultType = leadingResultType.has(opcode) && !call && before.slice(op + 1, i).every(token => token.kind === 'word' && !primitive.test(token.text));
    if (before[i - 1]?.text === 'to' || before[i - 1]?.text === 'x' || resultType) break;
    return value(readType(before, i).type);
  }
  // After `call <ret>`: the callee, which is a function or a pointer to one.
  if (['call', 'invoke', 'callbr'].includes(opcode) && !call && before.length > op + 1 &&
      !before.some((token, i) => token.kind === 'identifier' && before[i + 1]?.text === '(')) return value('ptr', { callee: true });
  if (binary.has(opcode) && last.text === ',' && before.filter(token => token.text === ',').length === 1) return value(firstType(before, op + 1)?.type);
  return undefined;
}

function formatIR(text, options = {}) {
  const analysis = analyze(text);
  const tabSize = Number.isInteger(options.tabSize) && options.tabSize > 0 ? Math.min(options.tabSize, 16) : 2;
  const indent = options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
  const quoted = analysis.tokens.filter(token => token.kind === 'string' || (token.kind === 'identifier' && token.text[1] === '"'));
  const inString = offset => quoted.some(token => offset > token.start && offset < token.end);
  const labels = new Set(analysis.symbols.filter(entry => entry.kind === 'label').map(entry => entry.start));
  let position = 0;
  return text.split(/(\r\n|\n|\r)/).map((line, index) => {
    const start = position; position += line.length;
    if (index % 2) return line;
    const leading = line.match(/^[\t ]*/)[0].length;
    const first = start + leading;
    const body = analysis.functions.some(fn => !fn.symbol.declaration && first >= fn.bodyStart && first < fn.bodyEnd);
    let end = line.length;
    while (end > 0 && /[\t ]/.test(line[end - 1]) && !inString(start + end - 1)) end--;
    if (inString(start)) return line.slice(0, end);
    if (end <= leading) return '';
    return (body && !labels.has(first) ? indent : '') + line.slice(leading, end);
  }).join('');
}

module.exports = { dominatorTree, analyze, tokenAt, symbolAt, references, visibleSymbols, callAt, callArguments, availableValues, completionContext, blockGraph, formatIR,
  // For checks.js; not a stable interface.
  internals: { functionContaining, lex, readType, firstType, splitTop, matching, closeFor, primitive, operations, terminators, controlFlow, opcodeIndex, statementStart, resolve, canonicalName, sameName, memberType } };
