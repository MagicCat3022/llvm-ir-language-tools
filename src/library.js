'use strict';

// Curated offline help, not an ABI database or a declaration generator.
const { canonicalName, decodedName } = require('./symbol-names');
const POSIX = 'https://pubs.opengroup.org/onlinepubs/9799919799/functions/';
const LLVM = 'https://llvm.org/docs/LangRef.html#';
const ABI = 'C library convention; the actual declaration and target govern the ABI. An opaque ptr does not identify its pointee type.';
const VERSION = 'The source declaration and LLVM version determine the exact prototype; target support may vary.';
const catalog = [];
const libc = new Map();
const intrinsic = [];
const p = (name, description) => ({ name, description });
const compact = type => typeof type === 'string' ? type.replace(/\s+/g, '') : '';
const integer = type => /^i(?:16|32|64|128)$/.test(compact(type));
const cInt = type => /^i(?:16|32|64)$/.test(compact(type));
const pointer = type => typeof type === 'string' && /^(?:ptr(?:addrspace\(\d+\))?|(?:i\d+|%[^()*,]+)(?:addrspace\(\d+\))?\*)$/.test(compact(type));
function signature(symbol, result, args, variadic = false) {
  const matches = (type, expected) => typeof expected === 'function' ? expected(type) : compact(type) === compact(expected);
  return matches(symbol.returnType, result) && Boolean(symbol.variadic) === variadic &&
    Array.isArray(symbol.parameters) && symbol.parameters.length === args.length &&
    symbol.parameters.every((param, i) => matches(param.type, args[i]));
}
function add(entry) {
  entry.parameters.forEach(Object.freeze);
  Object.freeze(entry.parameters); Object.freeze(entry.notes); Object.freeze(entry);
  catalog.push(entry);
  return entry;
}
function c(name, summary, parameters, returns, notes, result, args, variadic = false, page = name, details) {
  const entry = add({ name, category: 'libc', summary, parameters, returns, notes: [...notes, ABI], url: `${POSIX}${page}.html`, ...(details ? { details } : {}) });
  libc.set(name, { entry, check: symbol => signature(symbol, result, args, variadic) });
}
function ir(name, summary, parameters, returns, notes, anchor, match, check) {
  const entry = add({ name, category: 'intrinsic', summary, parameters, returns, notes: [...notes, VERSION], url: `${LLVM}${anchor}` });
  intrinsic.push({ entry, match, check });
}

const printfDetails = [
  '| Conversion | Expected C argument / output |',
  '| --- | --- |',
  '| `%d`, `%i` | `int`, signed decimal |',
  '| `%u` | `unsigned int`, decimal |',
  '| `%o` | `unsigned int`, octal |',
  '| `%x`, `%X` | `unsigned int`, hexadecimal (lower/upper case) |',
  '| `%f`, `%F` | `double`, fixed-point |',
  '| `%e`, `%E` | `double`, scientific notation |',
  '| `%g`, `%G` | `double`, compact fixed/scientific notation |',
  '| `%a`, `%A` | `double`, hexadecimal floating-point |',
  '| `%c` | `int`, converted to an unsigned byte |',
  '| `%s` | pointer to characters; normally a null-terminated string |',
  '| `%p` | `void *`, implementation-defined pointer representation |',
  '| `%n` | pointer to integer; writes the byte count so far, prints nothing |',
  '| `%%` | literal percent sign; consumes no argument |',
  '',
  'Form: `%[flags][width][.precision][length]conversion`.',
  'Flags: `-` left-aligns, `+` forces a sign, space reserves a sign column, `#` requests an alternate form, `0` requests zero padding (only where the conversion permits).',
  'Width is a minimum field width, not a buffer bound. `*` consumes an `int` width; `.*` consumes an `int` precision. Negative width means left alignment; negative precision is treated as omitted.',
  'Precision controls integer minimum digits, floating-point digits, or the maximum bytes read/output by `%s` (so an adequately bounded string need not terminate within that bound).',
  'Integer lengths: `hh` char, `h` short, `l` long, `ll` long long, `j` intmax_t, `z` size_t / signed counterpart, `t` ptrdiff_t / unsigned counterpart. `%zu` prints size_t. `%ld` means long, not universally i64: LP64 uses 64-bit long, LLP64 uses 32-bit long.',
  '`L` selects long double for floating conversions; `l` has no effect on printf floating conversions, but `%lc` / `%ls` select wide characters/strings.',
  'C default argument promotions apply to variadic arguments: float becomes double; narrow integers undergo integer promotion (usually to int, otherwise unsigned int). LLVM IR calls must already supply the ABI-correct promoted values; call syntax does not promote them.',
  'Formats and argument types must agree. Treat untrusted text as data (for example, a `%s` argument), not as the format; `%n` writes memory. Positional `$`, locale-specific behavior and additional conversions are implementation/standard-specific. This help does not validate format strings.'
].join('\n\n').replace(/\|\n\n\|/g, '|\n|');
const format = p('format', 'Pointer to the format string; conversions consume subsequent variadic arguments.');
const values = p('...', 'Values matching the conversions after C default argument promotions.');
const printfNotes = ['Counts are bytes, not Unicode character counts; a negative return indicates an error.'];
c('printf', 'Writes formatted output to stdout.', [format, values], 'Number of bytes transmitted on success; negative on error.', printfNotes, cInt, [pointer], true, 'fprintf', printfDetails);
c('fprintf', 'Writes formatted output to a stream.', [p('stream', 'Pointer to the C stream object.'), format, values], 'Number of bytes transmitted on success; negative on error.', printfNotes, cInt, [pointer, pointer], true, 'fprintf', printfDetails);
c('sprintf', 'Writes formatted output and a terminating null byte into a buffer.', [p('destination', 'Writable buffer with enough room for all output and its terminator.'), format, values], 'Bytes written, excluding the terminator; negative on error.', ['No capacity argument: the caller must provide sufficient storage. Overlapping source/destination objects give undefined behavior.'], cInt, [pointer, pointer], true, 'fprintf', printfDetails);
c('snprintf', 'Writes formatted output within a supplied buffer capacity.', [p('destination', 'Output buffer; may be null when capacity is zero.'), p('capacity', 'Buffer capacity in bytes, including room for the terminator.'), format, values], 'Bytes that would have been written without truncation, excluding the terminator; negative on error. This is not necessarily the stored count.', ['With positive capacity, stores at most capacity - 1 output bytes and a terminator. A nonnegative return greater than or equal to capacity means truncation.', 'Overlapping source/destination objects give undefined behavior.'], cInt, [pointer, integer, pointer], true, 'fprintf', printfDetails);
c('puts', 'Writes a string to stdout and appends a newline.', [p('string', 'Pointer to a null-terminated character string.')], 'Nonnegative on success; EOF on error (not a portable byte count).', ['Does not interpret percent conversions and does not write the null terminator.'], cInt, [pointer]);
c('putchar', 'Writes one byte to stdout.', [p('character', 'C int converted to unsigned char for output.')], 'The written unsigned byte converted to int; EOF on error.', [], cInt, [cInt]);

const scanfDetails = [
  'Input conversions consume pointers to writable destinations, not printf-style values.',
  '| Conversion | Destination |', '| --- | --- |',
  '| `%d` / `%i` | `int *`: decimal / base-detecting integer |',
  '| `%u`, `%o`, `%x` | `unsigned int *`: decimal / octal / hexadecimal |',
  '| `%f`, `%e`, `%g`, `%a` | `float *`; `%lf` (and corresponding `l` forms) needs `double *`; `L` needs `long double *` |',
  '| `%s`, `%[` | character buffer; adds a null terminator |',
  '| `%c` | character buffer; does not add a terminator or skip leading whitespace |',
  '| `%p` | `void **`, not `void *` |',
  '| `%n` | integer pointer; stores consumed byte count, does not increment assignment count |',
  '| `%%` | matches a literal percent; no destination |',
  '',
  '`*` suppresses assignment and consumes no destination argument; it does not read a width argument. Width is a literal maximum input width; reserve one extra byte for the `%s` / `%[` terminator. There is no printf-style precision.',
  'Integer length modifiers change the destination type (`hh`, `h`, `l`, `ll`, `j`, `z`, `t`). Pointer arguments are not float-to-double promoted: `%f` and `%lf` remain different.',
  'Check the assignment count before using outputs. A type mismatch or an unrepresentable converted number has undefined behavior; this is not a general checked numeric parser. Most conversions skip whitespace, but `%c`, `%[` and `%n` do not. POSIX `%m` allocation and positional syntax are not universal C features.'
].join('\n\n').replace(/\|\n\n\|/g, '|\n|');
for (const name of ['scanf', 'fscanf', 'sscanf']) {
  const first = name === 'scanf' ? [] : [p(name === 'sscanf' ? 'input' : 'stream', name === 'sscanf' ? 'Pointer to the null-terminated input string.' : 'Pointer to the input stream.')];
  c(name, `Reads formatted input from ${name === 'scanf' ? 'stdin' : name === 'sscanf' ? 'a string' : 'a stream'} into destinations.`, [...first, p('format', 'Input conversion format string.'), p('...', 'Pointers to correctly typed, sufficiently large writable destinations.')], 'Number of successful assignments (possibly zero); EOF if input failure occurs before the first conversion completes.', ['Assignment suppression and %n do not add to the return count. scanf rules differ from printf rules.'], cInt, name === 'scanf' ? [pointer] : [pointer, pointer], true, 'fscanf', scanfDetails);
}
c('malloc', 'Allocates uninitialized storage.', [p('size', 'Requested number of bytes (C size_t).')], 'Allocated pointer on success; null on allocation failure.', ['A zero-size request is implementation-defined; do not dereference its result. Free successful allocations when finished. Fundamental alignment is not a promise of arbitrary over-alignment.'], pointer, [integer]);
c('calloc', 'Allocates an array and clears its storage to all-zero bits.', [p('count', 'Number of elements.'), p('size', 'Bytes per element.')], 'Allocated pointer on success; null on failure, including size-product overflow under POSIX.', ['All-zero bits are not a portable guarantee of null pointers or every floating-point zero representation. Zero-size requests are implementation-defined.'], pointer, [integer, integer]);
c('realloc', 'Resizes an allocation, preserving bytes up to the smaller of old and new sizes.', [p('allocation', 'Existing allocation pointer, or null to request a new allocation.'), p('size', 'New size in bytes.')], 'Pointer to the resized allocation on success; null on allocation failure.', ['For a nonzero requested size, allocation failure leaves the original allocation intact; keep its pointer until success is known.', 'On success the allocation may move; old pointers must not be used. Zero-size behavior differs across C versions and implementations—avoid relying on it.'], pointer, [pointer, integer]);
c('free', 'Releases an allocation.', [p('allocation', 'Null, or a live pointer returned by a compatible allocation function.')], 'No value.', ['Null is a no-op. Interior pointers, double-free and use-after-free are invalid.'], 'void', [pointer]);
for (const name of ['memcpy', 'memmove']) c(name, `Copies bytes ${name === 'memmove' ? 'while permitting overlap' : 'between non-overlapping objects'}.`, [p('destination', 'Writable destination.'), p('source', 'Readable source.'), p('count', 'Number of bytes.')], 'The destination pointer; no error sentinel.', [name === 'memcpy' ? 'Overlapping copies have undefined behavior; use memmove when ranges may overlap.' : 'Behaves as if bytes were copied through independent temporary storage.', 'The caller must provide valid accessible ranges; no buffer-size check is performed.'], pointer, [pointer, pointer, integer]);
c('memset', 'Fills memory with a repeated byte.', [p('destination', 'Writable destination.'), p('value', 'C int converted to unsigned char.'), p('count', 'Number of bytes to fill.')], 'The destination pointer.', ['This is a byte fill, not assignment of arbitrary typed values. It is not a guaranteed secure-erasure primitive.'], pointer, [pointer, cInt, integer]);
c('strlen', 'Counts bytes before the first null byte in a string.', [p('string', 'Readable null-terminated string.')], 'Length as C size_t, excluding the terminator.', ['Counts bytes, not Unicode characters. Requires a terminator within accessible memory.'], integer, [pointer]);
c('strcmp', 'Lexicographically compares null-terminated strings by unsigned byte values.', [p('left', 'First string.'), p('right', 'Second string.')], 'Negative, zero, or positive when left sorts before, equals, or follows right.', ['Only the sign is portable; do not expect exactly -1 or +1. Not locale collation or constant-time comparison.'], cInt, [pointer, pointer]);
c('exit', 'Terminates normally, invoking atexit handlers and flushing/closing streams.', [p('status', 'C exit status; zero/EXIT_SUCCESS denotes success, EXIT_FAILURE failure.')], 'Does not return.', ['Operating systems determine how the exit status is observed. Unlike _Exit, performs normal C library cleanup.'], 'void', [cInt]);
c('abort', 'Requests abnormal termination through SIGABRT.', [], 'Does not return.', ['Does not run normal atexit cleanup. Do not depend on buffered output being flushed.'], 'void', []);

// Parse bounded overload encodings, then compare the actual declaration types.
// No unanchored prefix matching: inline, atomic, constrained and VP families
// must not inherit documentation for a superficially similar intrinsic.
function intType(suffix, vectors = true) {
  const m = /^(?:(nxv|v)([1-9]\d{0,6}))?i([1-9]\d{0,6})$/.exec(suffix);
  if (!m || Number(m[3]) > 8388607 || (m[1] && (!vectors || Number(m[2]) > 1048576))) return undefined;
  return { type: m[1] ? `<${m[1] === 'nxv' ? 'vscale x ' : ''}${m[2]} x i${m[3]}>` : `i${m[3]}`, bits: Number(m[3]), flag: m[1] ? `<${m[1] === 'nxv' ? 'vscale x ' : ''}${m[2]} x i1>` : 'i1' };
}
function floatType(suffix) {
  const m = /^(?:(nxv|v)([1-9]\d{0,6}))?(f16|bf16|f32|f64|f80|f128|ppcf128)$/.exec(suffix);
  if (!m || (m[1] && Number(m[2]) > 1048576)) return undefined;
  const scalar = { f16: 'half', bf16: 'bfloat', f32: 'float', f64: 'double', f80: 'x86_fp80', f128: 'fp128', ppcf128: 'ppc_fp128' }[m[3]];
  return { type: m[1] ? `<${m[1] === 'nxv' ? 'vscale x ' : ''}${m[2]} x ${scalar}>` : scalar };
}
function ptrType(suffix) {
  const m = /^p(0|[1-9]\d{0,7})(i8)?$/.exec(suffix);
  if (!m || Number(m[1]) > 16777215) return undefined;
  return m[2] ? `i8${m[1] === '0' ? '' : ` addrspace(${m[1]})`}*` : `ptr${m[1] === '0' ? '' : ` addrspace(${m[1]})`}`;
}
function overload(family, parse = intType) {
  const prefix = family + '.';
  return name => name.startsWith(prefix) ? parse(name.slice(prefix.length)) : undefined;
}
for (const operation of ['memcpy', 'memmove', 'memset']) {
  const family = `llvm.${operation}`;
  const set = operation === 'memset';
  const match = name => {
    if (!name.startsWith(family + '.')) return undefined;
    const parts = name.slice(family.length + 1).split('.');
    if (parts.length !== (set ? 2 : 3)) return undefined;
    const destination = ptrType(parts[0]), source = set ? 'i8' : ptrType(parts[1]);
    const length = intType(parts.at(-1), false);
    return destination && source && length ? { args: [destination, source, length.type, 'i1'] } : undefined;
  };
  ir(family, set ? 'Fills a byte range with a repeated byte.' : `Copies a byte range${operation === 'memmove' ? ', allowing overlap' : ''}.`, [p('destination', 'Writable destination pointer.'), p(set ? 'value' : 'source', set ? 'Byte value (i8).' : 'Readable source pointer.'), p('length', 'Number of bytes.'), p('isvolatile', 'Constant i1 selecting volatile accesses.')], 'No value (unlike the libc routine).', [operation === 'memcpy' ? 'Source and destination must be equal or non-overlapping. This rule differs from libc memcpy.' : operation === 'memmove' ? 'Overlapping ranges are allowed.' : 'Fills bytes, not arbitrary typed elements.', 'Pointer address spaces and alignment attributes matter. Zero length does not waive constraints imposed by argument attributes.', 'Inline and element.unordered.atomic variants are separate, intentionally unsupported documentation families.'], `llvm-${operation}-${set ? 'intrinsics' : 'intrinsic'}`, match, (symbol, m) => signature(symbol, 'void', m.args));
}
for (const phase of ['start', 'end']) {
  const family = `llvm.lifetime.${phase}`;
  ir(family, `${phase === 'start' ? 'Begins' : 'Ends'} a stack allocation's accessible lifetime.`, [p('pointer', 'Stack allocation identified by the actual LLVM-version-specific declaration.'), p('size (older LLVM only)', 'Older signatures also take an i64 byte count; -1 denotes unknown size.')], 'No value.', ['Current LLVM uses an unsuffixed name with one pointer argument; older IR uses size-plus-pointer signatures, often with .p0 or .p0i8 overload suffixes.', phase === 'start' ? 'Starting the lifetime does not allocate memory; the object begins with uninitialized contents.' : 'Ending the lifetime does not free heap memory. Access restrictions and poison behavior follow the LLVM version.'], `llvm-lifetime-${phase}-intrinsic`, name => name === family ? { bare: true } : name.startsWith(family + '.') && ptrType(name.slice(family.length + 1)) ? { pointer: ptrType(name.slice(family.length + 1)) } : undefined, (symbol, m) => m.bare ? signature(symbol, 'void', [pointer]) || signature(symbol, 'void', ['i64', pointer]) : signature(symbol, 'void', ['i64', m.pointer]));
}
for (const kind of ['value', 'declare']) {
  const family = `llvm.dbg.${kind}`;
  const entry = add({ name: family, category: 'intrinsic', summary: kind === 'value' ? 'Describes a source variable value for debug information.' : 'Describes the address of a source variable for debug information.', parameters: [p(kind === 'value' ? 'value' : 'address', 'Value/address wrapped as metadata.'), p('variable', 'DILocalVariable metadata.'), p('expression', 'DIExpression describing how to interpret the value/address.')], returns: 'No value; does not implement a runtime assignment.', notes: [`Legacy debug intrinsic: modern LLVM uses #dbg_${kind} records instead. Records are not ordinary call instructions.`, VERSION], url: `https://llvm.org/docs/SourceLevelDebugging.html#llvm-dbg-${kind}` });
  intrinsic.push({ entry, match: name => name === family ? {} : undefined, check: symbol => signature(symbol, 'void', ['metadata', 'metadata', 'metadata']) });
}
ir('llvm.assume', 'Tells the optimizer a condition holds whenever execution reaches this point.', [p('condition', 'i1 condition that must be true.')], 'No value.', ['A false or poison condition gives undefined behavior; this is not a runtime assertion. Operand bundles can encode additional assumptions.'], 'llvm-assume-intrinsic', name => name === 'llvm.assume' ? {} : undefined, symbol => signature(symbol, 'void', ['i1']));
ir('llvm.trap', 'Terminates through a target trap (or a target fallback such as abort).', [], 'Does not return.', ['Not the same as a resumable debugger breakpoint.'], 'llvm-trap-intrinsic', name => name === 'llvm.trap' ? {} : undefined, symbol => signature(symbol, 'void', []));
ir('llvm.debugtrap', 'Requests the attention of a debugger using a target-dependent trap.', [], 'No value; unlike llvm.trap, it is not inherently noreturn.', ['Exact behavior depends on the target and debugger.'], 'llvm-debugtrap-intrinsic', name => name === 'llvm.debugtrap' ? {} : undefined, symbol => signature(symbol, 'void', []));
for (const probability of [false, true]) {
  const family = `llvm.expect${probability ? '.with.probability' : ''}`;
  ir(family, 'Hints which integer value is likely without changing the value.', [p('value', 'Actual value.'), p('expected', 'Expected value.'), ...(probability ? [p('probability', 'Constant double in [0, 1], likelihood of the expected value.')] : [])], 'The actual first argument, unchanged.', ['This is an optimization hint, not a correctness assertion; an unexpected value is allowed.'], `llvm-expect${probability ? '-with-probability' : ''}-intrinsic`, overload(family, suffix => intType(suffix, false)), (symbol, m) => signature(symbol, m.type, [m.type, m.type, ...(probability ? ['double'] : [])]));
}
for (const operation of ['ctpop', 'ctlz', 'cttz', 'bswap']) {
  const family = `llvm.${operation}`, zeroFlag = operation === 'ctlz' || operation === 'cttz';
  ir(family, { ctpop: 'Counts set bits, independently in each vector lane.', ctlz: 'Counts leading zero bits, independently in each vector lane.', cttz: 'Counts trailing zero bits, independently in each vector lane.', bswap: 'Reverses byte order within each integer or vector lane.' }[operation], [p('value', 'Integer scalar or integer vector.'), ...(zeroFlag ? [p('is_zero_poison', 'Constant i1: if true, a zero input produces poison; if false, it produces the element bit width.')] : [])], 'Same integer or vector type as the input.', [operation === 'bswap' ? 'Element bit width must be a positive multiple of 16; vector lane order is unchanged.' : zeroFlag ? 'The zero-control flag is scalar even when the input is a vector.' : 'Zero has a population count of zero.'], `llvm-${operation}-${operation === 'bswap' ? 'intrinsics' : 'intrinsic'}`, overload(family, suffix => { const m = intType(suffix); return m && (operation !== 'bswap' || m.bits % 16 === 0) ? m : undefined; }), (symbol, m) => signature(symbol, m.type, [m.type, ...(zeroFlag ? ['i1'] : [])]));
}
for (const operation of ['sqrt', 'fabs']) {
  const family = `llvm.${operation}`;
  ir(family, operation === 'sqrt' ? 'Computes a floating-point square root per scalar or vector lane.' : 'Clears the floating-point sign bit per scalar or vector lane.', [p('value', 'Floating-point scalar or vector.')], 'Same floating-point type as the input.', [operation === 'sqrt' ? 'Does not set errno or trap like a library call might. Fast-math flags may relax accuracy; constrained floating-point intrinsics are a separate family.' : 'Preserves all non-sign bits, including a NaN payload and quiet/signaling bit.'], `llvm-${operation}-intrinsic`, overload(family, floatType), (symbol, m) => signature(symbol, m.type, [m.type]));
}
for (const signed of ['s', 'u']) for (const operation of ['add', 'sub', 'mul']) {
  const family = `llvm.${signed}${operation}.with.overflow`;
  ir(family, `Computes ${signed === 's' ? 'signed' : 'unsigned'} ${ { add: 'addition', sub: 'subtraction', mul: 'multiplication' }[operation]} and reports overflow.`, [p('left', 'First integer scalar or vector.'), p('right', 'Second operand, of the same type.')], 'Struct containing the wrapped arithmetic result and an i1 overflow flag (a matching i1 vector for vector inputs).', ['Overflow itself is reported, not made undefined by this operation. Vector flags apply independently to each lane.'], `llvm-${signed}${operation}-with-overflow-intrinsics`, overload(family), (symbol, m) => signature(symbol, `{${m.type}, ${m.flag}}`, [m.type, m.type]));
}

function safeName(name) {
  if (typeof name !== 'string' || name.length > 512) return undefined;
  const raw = name.startsWith('@') ? name.slice(1) : name;
  if (!/^(?:[-a-zA-Z$._][-\w$._]*|"(?:[^"\\\x00-\x1f]|\\[a-fA-F0-9]{2})*")$/.test(raw)) return undefined;
  const decoded = decodedName(name);
  // Do not strip LLVM's \01 no-mangling marker, platform underscores or versions.
  return /^[a-zA-Z][a-zA-Z0-9._]*$/.test(decoded) ? decoded : undefined;
}
function declaration(symbol, name) {
  if (!symbol || symbol.kind !== 'function' || symbol.declaration !== true || typeof symbol.name !== 'string' || !symbol.name.startsWith('@')) return false;
  if (canonicalName(symbol.name) !== canonicalName('@' + name)) return false;
  // Inspect only the header before the name: a quoted parameter named "internal"
  // is not linkage. Reject non-C calling conventions and ABI-transforming attrs.
  const header = typeof symbol.definition === 'string' ? symbol.definition.split('@')[0] : '';
  return !/\b(?:internal|private|available_externally|alias|ifunc|(?:\w*cc)|cc\s*\d+)\b/.test(header.replace(/\bccc\b/g, '')) &&
    !/\b(?:sret|byval|inalloca|preallocated|swiftself|swifterror|nest)\s*(?:\(|\b)/.test(symbol.definition || '');
}
function lookupLibrary(name, symbol) {
  const normalized = safeName(name);
  if (!normalized || (symbol !== undefined && !declaration(symbol, normalized))) return undefined;
  const standard = libc.get(normalized);
  if (standard) return symbol === undefined || standard.check(symbol) ? standard.entry : undefined;
  for (const item of intrinsic) {
    const match = item.match(normalized);
    if (match && (symbol === undefined || item.check(symbol, match))) return item.entry;
  }
  return undefined;
}
function listLibraries() { return catalog.slice(); }

// Documented parameters in the order of `symbol`'s declaration: LLVM 22 dropped
// the size operand from llvm.lifetime.*, so two-operand forms keep the historical order.
function libraryParameters(entry, symbol) {
  return /^llvm\.lifetime\.(?:start|end)$/.test(entry.name) && symbol.parameters?.length === 2
    ? [entry.parameters[1], entry.parameters[0]] : entry.parameters;
}

module.exports = { lookupLibrary, listLibraries, libraryParameters };
