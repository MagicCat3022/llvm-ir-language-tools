'use strict';

// Built-in diagnostics that need no LLVM installation. Every check is
// conservative: when the parse cannot establish a fact (an unknown type, an
// unresolved branch target, implicit numbering), the check stays silent and
// llvm-as remains the authority.
const { internals } = require('./analysis');
const knowledge = require('./knowledge');
const { functionContaining, readType, firstType, splitTop, matching, closeFor, operations, terminators, controlFlow, opcodeIndex, statementStart, resolve, canonicalName } = internals;

const voidOperations = new Set('ret br switch indirectbr resume unreachable store fence catchret cleanupret'.split(' '));
const binary = new Set('add fadd sub fsub mul fmul udiv sdiv fdiv urem srem frem shl lshr ashr and or xor icmp fcmp'.split(' '));
const division = new Set('udiv sdiv urem srem'.split(' '));
const calls = new Set(['call', 'invoke', 'callbr']);
// Words that may begin a line inside an instruction or body without being an opcode.
const continuations = new Set('uselistorder uselistorder_bb to unwind cleanup catch filter'.split(' '));

// Edit distance counting a swap of adjacent characters as one edit.
function distance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  const rows = [Array.from({ length: right.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= left.length; i++) {
    const row = rows[i] = [i];
    for (let j = 1; j <= right.length; j++) {
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[left.length][right.length];
}

// The closest spelling among `names`, if it is a plausible typo.
function suggest(name, names) {
  const limit = Math.max(1, Math.min(2, Math.floor((name.length - 1) / 3)));
  let best, bestDistance = limit + 1;
  for (const candidate of names) {
    if (candidate === name) continue;
    const d = distance(name.toLowerCase(), candidate.toLowerCase(), limit);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return best;
}

const comparable = type => type && type !== 'unknown' && !/["*]/.test(type);
const sameType = (left, right) => left === right || /^%/.test(left) && /^%/.test(right) && canonicalName(left) === canonicalName(right);
const pointer = type => /^ptr(?: addrspace\(\d+\))?$/.test(type || '');

// Diagnostics and code actions check the same analysis; compute it once.
// Callers only read the result.
const checked = new WeakMap();
function checkIR(analysis) {
  let issues = checked.get(analysis);
  if (!issues) checked.set(analysis, issues = computeIssues(analysis));
  return issues;
}

function computeIssues(analysis) {
  const issues = [];
  const { code, statements, definitions, typeOffsets, blockaddressTargets } = analysis._index;
  const text = analysis.text;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue;
    if (text[i] === '\n' || text[i] === '\r') lineStarts.push(i + 1);
  }
  const lineOf = offset => {
    let low = 0, high = lineStarts.length - 1;
    while (low < high) { const middle = (low + high + 1) >>> 1; if (lineStarts[middle] <= offset) low = middle; else high = middle - 1; }
    return low + 1;
  };
  const report = (span, severity, code, message, extra) => issues.push({ start: span.start, end: span.end, severity, code, message, ...extra });
  const bodies = analysis.functions.filter(fn => fn.open && !fn.symbol.declaration);
  const bodyAt = offset => { const fn = functionContaining(analysis, offset); return fn?.open && !fn.symbol.declaration && offset >= fn.bodyStart && offset < fn.bodyEnd ? fn : undefined; };
  const fnOf = symbol => functionContaining(analysis, symbol.start);
  // Index of the first code token at or after `offset`.
  const codeIndex = offset => { let low = 0, high = code.length; while (low < high) { const middle = (low + high) >>> 1; if (code[middle].start < offset) low = middle + 1; else high = middle; } return low; };
  const values = new Set(['variable', 'parameter', 'global', 'function']);
  const valueType = symbol => symbol.kind === 'variable' || symbol.kind === 'parameter' ? symbol.type
    : (symbol.kind === 'global' || symbol.kind === 'function') && !/addrspace/.test(symbol.definition) ? 'ptr' : undefined;

  // Function bodies: missing braces and bodies.
  for (const fn of analysis.functions) {
    if (fn.symbol.declaration) continue;
    if (!fn.open) report(fn.symbol, 'error', 'missing-body', `define needs a body in { … }; use declare for a function defined elsewhere.`);
    else if (fn.unclosed) report(fn.open, 'error', 'unclosed-body', `The body of ${fn.name} has no closing }.`);
  }

  // Duplicate definitions, per LLVM namespace.
  const groups = new Map();
  for (const symbol of analysis.symbols) {
    let namespace;
    if (symbol.scope === null) {
      if (symbol.name[0] === '@') namespace = 'global';
      else if (symbol.kind === 'type') namespace = 'type';
      else if (symbol.kind === 'metadata' && /^!\d+$/.test(symbol.name)) namespace = 'metadata';
    } else if (['variable', 'parameter', 'label'].includes(symbol.kind)) {
      const fn = fnOf(symbol);
      if (fn) namespace = `local\0${fn.start}`;
    }
    if (!namespace) continue;
    const id = `${namespace}\0${canonicalName(symbol.name)}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(symbol);
  }
  for (const group of groups.values()) {
    for (const symbol of group.slice(1)) {
      const first = group[0], line = lineOf(first.start);
      const message = symbol.scope === null ? `${symbol.name} is already defined on line ${line}.`
        : `${symbol.name} is already defined on line ${line}; values, parameters and blocks share one namespace per function.`;
      report(symbol, 'error', 'duplicate-definition', message, { related: [{ start: first.start, end: first.end, message: `First definition of ${first.name}` }] });
    }
  }

  // Implicit numbering: unnamed parameters, blocks and results take the next number.
  const numbered = new Map();
  for (const fn of bodies) {
    const flow = controlFlow(analysis, fn);
    const defined = new Set(), problems = [];
    let next = 0, certain = true;
    const take = (number, span, what) => {
      if (number === undefined) { defined.add(next++); return; }
      // LLVM 19+ accepts gaps; numbers must still increase.
      if (number < next) problems.push([span, 'error', `${what} expected to be numbered %${next} or greater; unnamed values and blocks count too.`]);
      defined.add(number); next = Math.max(next, number + 1);
    };
    for (const parameter of fn.symbol.parameters || []) {
      if (!parameter.name) take(undefined);
      else if (/^%\d+$/.test(parameter.name)) take(Number(parameter.name.slice(1)), parameter, 'Parameter');
    }
    for (const block of flow.blocks) {
      if (!block.label) take(undefined);
      else if (/^%\d+$/.test(block.label.name)) take(Number(block.label.name.slice(1)), block.label, 'Block');
      for (const statement of block.statements) {
        const op = statement.tokens[opcodeIndex(statement.tokens)]?.text;
        if (statement.symbol) {
          if (/^%\d+$/.test(statement.symbol.name)) take(Number(statement.symbol.name.slice(1)), statement.symbol, 'Value');
        } else if (!operations.has(op) || calls.has(op) && statement.type === 'unknown') certain = false;
        else if (!voidOperations.has(op) && statement.type !== 'void') take(undefined);
      }
    }
    if (!certain) continue;
    numbered.set(fn, defined);
    for (const [span, severity, message] of problems) report(span, severity, 'numbering', message);
  }

  // Undefined names, and which symbols are used at all.
  const used = new Set();
  const globalNames = analysis.symbols.filter(symbol => symbol.scope === null && symbol.name[0] === '@').map(symbol => symbol.name);
  for (let i = 0; i < code.length; i++) {
    const token = code[i];
    if (token.kind !== 'identifier' || definitions.has(token.start)) continue;
    const symbol = resolve(analysis, token);
    if (symbol) { used.add(symbol); continue; }
    const sigil = token.text[0], fn = bodyAt(token.start);
    if (sigil === '!') {
      if (/^!\d+$/.test(token.text)) report(token, 'error', 'undefined-metadata', `Metadata ${token.text} is not defined.`);
    } else if (sigil === '#') {
      if (/^#\d+$/.test(token.text)) report(token, 'warning', 'undefined-attributes', `Attribute group ${token.text} is not defined, so LLVM silently drops it.`);
    } else if (sigil === '@') {
      const replacement = suggest(token.text, globalNames);
      report(token, 'error', 'undefined-value', `${token.text} is not defined in this module${replacement ? `. Did you mean ${replacement}?` : '; add a declaration.'}`, { replacement, global: true });
    } else if (typeOffsets.has(token.start)) {
      report(token, 'error', 'undefined-type', `Type ${token.text} is not defined.`);
    } else if (blockaddressTargets.has(token.start) || fn) {
      if (/^%\d+$/.test(token.text) && (!fn || !numbered.has(fn) || numbered.get(fn).has(Number(token.text.slice(1))))) continue;
      const scope = fn?.name ?? blockaddressTargets.get(token.start);
      const label = code[i - 1]?.text === 'label' || blockaddressTargets.has(token.start);
      const names = analysis.symbols.filter(entry => entry.scope !== null && canonicalName(entry.scope) === canonicalName(scope) &&
        (label ? entry.kind === 'label' : entry.kind !== 'label')).map(entry => entry.name);
      const replacement = suggest(token.text, names);
      report(token, 'error', label ? 'undefined-label' : 'undefined-value',
        `${label ? 'Block' : 'Value'} ${token.text} is not defined in ${scope}${replacement ? `. Did you mean ${replacement}?` : '.'}`, { replacement });
    }
  }

  const expect = (token, expected) => {
    const symbol = resolve(analysis, token);
    if (!symbol || !values.has(symbol.kind)) return;
    const actual = valueType(symbol);
    if (comparable(actual) && comparable(expected) && !sameType(actual, expected))
      report(token, 'error', 'type-mismatch', `${token.text} has type ${actual}, but ${expected} is expected here.`);
  };

  for (const fn of bodies) {
    const flow = controlFlow(analysis, fn);
    const { blocks, dominators } = flow;
    if (!blocks.length) { report(fn.open, 'error', 'empty-body', `${fn.name} has no instructions; a body needs at least one block ending in a terminator such as ret.`); continue; }
    const byName = new Map(blocks.map((block, i) => [block.label && canonicalName(block.label.name), i]).filter(([name]) => name));
    const blockOf = new Map();
    blocks.forEach((block, i) => { for (const statement of block.statements) if (statement.symbol) blockOf.set(statement.symbol, i); });
    const blockName = i => blocks[i].label?.name || (i ? 'an unlabeled block' : 'the entry block');
    // Unknown successors (e.g. implicitly numbered blocks) make edge-based checks unreliable.
    const complete = blocks.every(block => block.successors.every(name => byName.has(name)));
    const predecessors = blocks.map(() => new Set());
    blocks.forEach((block, i) => { for (const name of block.successors) if (byName.has(name)) predecessors[byName.get(name)].add(i); });

    blocks.forEach((block, i) => {
      const last = block.statements[block.statements.length - 1];
      const lastOp = last?.tokens[opcodeIndex(last.tokens)]?.text;
      if (!last || !terminators.has(lastOp)) {
        const span = block.label || { start: statementStart(last), end: last.tokens[last.tokens.length - 1]?.end ?? last.symbol.end };
        report(span, 'error', 'missing-terminator', `${block.label ? `Block ${block.label.name}` : i ? 'This block' : 'The entry block'} does not end with a terminator (ret, br, switch, unreachable, …).`);
      }
      if (i && !block.label) {
        const first = block.statements[0], end = last.tokens[last.tokens.length - 1]?.end ?? last.symbol.end;
        report({ start: statementStart(first), end }, 'warning', 'unreachable-code', 'Unreachable: these instructions follow a terminator and have no label, so nothing can branch to them.', { unnecessary: true });
      }
      let body = false;
      for (const statement of block.statements) {
        const op = statement.tokens[opcodeIndex(statement.tokens)];
        if (op?.text !== 'phi') { body = true; continue; }
        if (body) report(op, 'error', 'phi-position', 'phi instructions must be grouped at the start of their block.');
        else if (!i) report(op, 'error', 'phi-position', 'The entry block has no predecessors, so it cannot contain phi.');
      }
    });

    // Entry-block branches and reachability.
    const entry = blocks[0].label && canonicalName(blocks[0].label.name);
    const addressed = new Set([...blockaddressTargets.keys()].map(offset => canonicalName(code[codeIndex(offset)]?.text || '')));
    for (const block of blocks) {
      for (const statement of block.statements) {
        statement.tokens.forEach((token, j) => {
          const target = statement.tokens[j + 1];
          if (token.text !== 'label' || target?.kind !== 'identifier') return;
          if (entry && canonicalName(target.text) === entry) report(target, 'error', 'entry-branch', 'The entry block cannot be a branch target; branch to a new block instead.');
          const symbol = resolve(analysis, target);
          if (symbol && symbol.kind !== 'label') report(target, 'error', 'not-a-label', `${target.text} is a ${symbol.kind}, not a block.`);
        });
      }
    }
    if (complete) {
      const reached = new Set([0]), queue = [0];
      while (queue.length) for (const name of blocks[queue.shift()].successors) {
        const next = byName.get(name);
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
      blocks.forEach((block, i) => {
        if (!reached.has(i) && block.label && !addressed.has(canonicalName(block.label.name)))
          report(block.label, 'hint', 'unreachable-block', `Block ${block.label.name} is unreachable: no path from the entry block branches to it.`, { unnecessary: true });
      });
    }

    // Instructions.
    blocks.forEach((block, i) => {
      for (const statement of block.statements) {
        const tokens = statement.tokens, o = opcodeIndex(tokens), op = tokens[o];
        const start = statementStart(statement);
        if (!op) { report(statement.symbol, 'error', 'missing-instruction', `Expected an instruction after ${statement.symbol.name} =.`); continue; }
        if (!operations.has(op.text)) {
          const replacement = suggest(op.text, [...operations]);
          report(op, 'error', 'unknown-instruction', `Unknown instruction ${op.text}${replacement ? `. Did you mean ${replacement}?` : '.'}`, { replacement });
          continue;
        }
        if (statement.symbol && (voidOperations.has(op.text) || statement.type === 'void'))
          report(statement.symbol, 'error', 'void-result', `${voidOperations.has(op.text) ? op.text : 'This call'} produces no value, so its result cannot be named.`);
        const parts = splitTop(tokens, o + 1);
        if (op.text === 'ret') {
          const returned = tokens[o + 1]?.text === 'void' ? 'void' : readType(tokens, o + 1)?.type;
          const declared = fn.symbol.returnType;
          if (!tokens[o + 1]) report(op, 'error', 'return-type', `ret needs an operand: ${declared === 'void' ? 'ret void' : `ret ${declared} <value>`}.`);
          else if (comparable(returned) && comparable(declared) && !sameType(returned, declared))
            report({ start: op.start, end: tokens[tokens.length - 1].end }, 'error', 'return-type', `${fn.name} returns ${declared}, but this returns ${returned}.`);
        }
        if (op.text === 'store' || op.text === 'load') {
          const address = firstType(parts[1] || [], 0)?.type;
          if (address && !pointer(address) && comparable(address))
            report({ start: op.start, end: tokens[tokens.length - 1].end }, 'error', 'memory-operands', op.text === 'store'
              ? `The second store operand is the address: store <type> <value>, ptr <address>.`
              : `load reads through a pointer: load <type>, ptr <address>.`);
        }
        if (division.has(op.text) && parts[1]?.length === 1 && /^-?0+$/.test(parts[1][0].text))
          report(parts[1][0], 'warning', 'division-by-zero', 'Division by zero is undefined behavior.');

        // Operand types, and dominance of the values they name.
        let callOpen = -1, callClose = -1;
        if (calls.has(op.text)) {
          callOpen = tokens.findIndex((token, j) => j > o && token.kind === 'identifier' && tokens[j + 1]?.text === '(') + 1;
          callClose = callOpen > 0 ? matching(tokens, callOpen) : -1;
          if (callOpen > 0 && callClose > 0) checkCall(tokens, o, callOpen, callClose, statement);
        }
        if (op.text === 'phi') {
          const type = firstType(tokens, o + 1)?.type;
          tokens.forEach((token, j) => {
            if (token.text !== '[') return;
            const [value, label] = splitTop(tokens, j + 1, matching(tokens, j));
            if (value?.length === 1 && value[0].kind === 'identifier') expect(value[0], type);
            const from = label?.length === 1 && byName.get(canonicalName(label[0].text));
            const symbol = value?.length === 1 && resolve(analysis, value[0]);
            if (from !== undefined && from !== false && symbol?.kind === 'variable' && blockOf.has(symbol) && !dominators[from].has(blockOf.get(symbol)))
              report(value[0], 'error', 'dominance', `${value[0].text} is defined in ${blockName(blockOf.get(symbol))}, which does not dominate ${label[0].text}, where this incoming value comes from.`);
          });
          if (complete && i && block.label) {
            const incoming = new Map();
            tokens.forEach((token, j) => {
              if (token.text !== '[') return;
              const label = splitTop(tokens, j + 1, matching(tokens, j))[1];
              if (label?.length === 1) incoming.set(canonicalName(label[0].text), label[0]);
            });
            const expected = new Set([...predecessors[i]].map(p => blocks[p].label && canonicalName(blocks[p].label.name)));
            for (const [name, token] of incoming) if (!expected.has(name) && byName.has(name))
              report(token, 'error', 'phi-predecessors', `${token.text} does not branch to ${block.label.name}, so it cannot supply an incoming value.`);
            for (const p of predecessors[i]) if (blocks[p].label && !incoming.has(canonicalName(blocks[p].label.name)))
              report(op, 'error', 'phi-predecessors', `Missing an incoming value for predecessor ${blocks[p].label.name}.`);
          }
          continue;
        }
        const secondOperand = binary.has(op.text) && parts[1]?.length === 1 ? parts[1][0] : undefined;
        tokens.forEach((token, j) => {
          if (token.kind !== 'identifier' || !/^[%@]/.test(token.text) || tokens[j + 1]?.text === '(') return;
          const symbol = resolve(analysis, token);
          if (symbol?.kind === 'variable' && blockOf.has(symbol)) {
            const at = blockOf.get(symbol);
            if (symbol.start === start) report(token, 'error', 'dominance', `${token.text} uses its own result; only phi may refer to itself.`);
            else if (at === i ? symbol.start > start : !dominators[i].has(at))
              report(token, 'error', 'dominance', at === i ? `${token.text} is used before its definition.`
                : `${token.text} is defined in ${blockName(at)}, which does not dominate this use: some path reaches here without defining it.`);
          }
          if (j > callOpen && j < callClose) return;
          if (token === secondOperand) return expect(token, firstType(tokens, o + 1)?.type);
          for (let k = j - 1; k > o && k >= j - 16; k--) {
            if (readType(tokens, k)?.next !== j) continue;
            if (tokens[k - 1]?.text !== 'x') expect(token, readType(tokens, k).type);
            break;
          }
        });
      }
    });

    // Unknown words where an instruction should start.
    let depth = 0, previous;
    for (let k = codeIndex(fn.bodyStart); k < code.length && code[k].start < fn.bodyEnd; k++) {
      const token = code[k];
      const lineStart = !previous || /[\r\n]/.test(text.slice(previous.end, token.start));
      // Known keywords continue an instruction (`to label`, landingpad `cleanup`).
      if (lineStart && !depth && token.kind === 'word' && !operations.has(token.text) && !continuations.has(token.text) && !knowledge.lookup(token.text) &&
          code[k + 1]?.text !== ':' && !readType([token], 0)) {
        const replacement = suggest(token.text, [...operations]);
        report(token, 'error', 'unknown-instruction', `Expected an instruction, found ${token.text}${replacement ? `. Did you mean ${replacement}?` : '.'}`, { replacement });
      }
      if (closeFor[token.text]) depth++;
      else if (/^[)\]}>]$/.test(token.text)) depth = Math.max(0, depth - 1);
      previous = token;
    }
  }

  function checkCall(tokens, o, open, close, statement) {
    const callee = tokens[open - 1], symbol = resolve(analysis, callee);
    const args = splitTop(tokens, open + 1, close);
    const argTypes = args.map(part => {
      const type = firstType(part, 0)?.type;
      const value = part[part.length - 1];
      if (part.length > 1 && value.kind === 'identifier') expect(value, type);
      return type;
    });
    if (symbol?.kind !== 'function') return;
    const parameters = symbol.parameters || [];
    const span = { start: callee.start, end: tokens[close].end };
    const explicit = tokens.slice(o + 1, open - 1).some(token => token.text === '(');
    if (symbol.variadic && !explicit && args.length >= parameters.length) {
      const type = `(${parameters.map(parameter => parameter.type).concat('...').join(', ')})`;
      report(callee, 'warning', 'variadic-call', `${symbol.name} is variadic, and LangRef requires calls to variadic functions to spell the function type: ${tokens[o].text} ${symbol.returnType} ${type} ${symbol.name}(…).`, { insert: { offset: callee.start, text: `${type} ` } });
    }
    if (symbol.variadic ? args.length < parameters.length : args.length !== parameters.length) {
      report(span, 'warning', 'call-signature', `${symbol.name} takes ${symbol.variadic ? 'at least ' : ''}${parameters.length} argument${parameters.length === 1 ? '' : 's'}, but this call passes ${args.length}.`);
      return;
    }
    parameters.forEach((parameter, i) => {
      if (comparable(argTypes[i]) && comparable(parameter.type) && !sameType(argTypes[i], parameter.type))
        report({ start: args[i][0].start, end: args[i][args[i].length - 1].end }, 'warning', 'call-signature', `Argument ${i + 1} of ${symbol.name} is ${parameter.type}, but this call passes ${argTypes[i]}.`);
    });
    if (comparable(statement.type) && comparable(symbol.returnType) && !sameType(statement.type, symbol.returnType))
      report(callee, 'warning', 'call-signature', `${symbol.name} returns ${symbol.returnType}, but this call expects ${statement.type}.`);
  }

  // Unused names: never referenced SSA values, private symbols and declarations.
  for (const symbol of analysis.symbols) {
    if (used.has(symbol)) continue;
    if (symbol.kind === 'variable' && !/^%\d+$/.test(symbol.name) && bodyAt(symbol.start))
      report(symbol, 'hint', 'unused-value', `${symbol.name} is never used.`, { unnecessary: true });
    else if (symbol.scope === null && symbol.kind === 'function' && symbol.declaration && !reused(symbol))
      report(symbol, 'hint', 'unused-declaration', `${symbol.name} is declared but never used.`, { unnecessary: true });
    else if (symbol.scope === null && (symbol.kind === 'function' || symbol.kind === 'global') && /^(?:@\S+\s*=\s*|define\s+)(?:private|internal)\b/.test(symbol.definition) && !reused(symbol))
      report(symbol, 'hint', 'unused-private', `${symbol.name} is ${/\bprivate\b/.test(symbol.definition) ? 'private' : 'internal'} and never used.`, { unnecessary: true });
  }
  // A declaration and a definition of one function resolve to the definition.
  function reused(symbol) { return [...used].some(other => other !== symbol && other.scope === null && canonicalName(other.name) === canonicalName(symbol.name)); }

  return issues.sort((left, right) => left.start - right.start);
}

module.exports = { checkIR, suggest };
