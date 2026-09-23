'use strict';

// Curated hover notes, not an exhaustive substitute for the LLVM Language Reference.
// Syntax strings are sketches: optional flags and attributes may be omitted.
const base = 'https://llvm.org/docs/LangRef.html#';
const entries = Object.create(null);

function add(name, kind, summary, anchor, syntax, details) {
  entries[name] = Object.freeze({ summary, ...(syntax ? { syntax } : {}), ...(details ? { details } : {}), url: base + anchor, kind });
}

const comparisonDetails = {
  icmp: [
    '`<cond>` selects the comparison below. Both operands have the same type; `u` uses unsigned values and `s` uses signed values.',
    '',
    '| Condition | True when |',
    '| --- | --- |',
    '| `eq` | `op1 == op2` (no signedness distinction) |',
    '| `ne` | `op1 != op2` (no signedness distinction) |',
    '| `ugt` | `op1 > op2`, unsigned |',
    '| `uge` | `op1 >= op2`, unsigned |',
    '| `ult` | `op1 < op2`, unsigned |',
    '| `ule` | `op1 <= op2`, unsigned |',
    '| `sgt` | `op1 > op2`, signed |',
    '| `sge` | `op1 >= op2`, signed |',
    '| `slt` | `op1 < op2`, signed |',
    '| `sle` | `op1 <= op2`, signed |',
    '',
    'Scalar operands produce `i1`; vectors compare corresponding lanes and produce an `i1` vector with the same lane count (for example `<N x i1>`).',
    '',
    '`samesign` promises matching operand signs. Differing signs produce `poison`, not a normal true/false result.'
  ].join('\n'),
  fcmp: [
    '`<cond>` selects the comparison below. Ordered means neither operand is NaN; unordered means at least one operand is NaN. For `fcmp`, the `u` prefix means unordered, not unsigned.',
    '',
    '| Condition | True when |',
    '| --- | --- |',
    '| `false` | Never |',
    '| `oeq` | Ordered and `op1 == op2` |',
    '| `ogt` | Ordered and `op1 > op2` |',
    '| `oge` | Ordered and `op1 >= op2` |',
    '| `olt` | Ordered and `op1 < op2` |',
    '| `ole` | Ordered and `op1 <= op2` |',
    '| `one` | Ordered and `op1 != op2` |',
    '| `ord` | Neither operand is NaN |',
    '| `ueq` | Unordered or `op1 == op2` |',
    '| `ugt` | Unordered or `op1 > op2` |',
    '| `uge` | Unordered or `op1 >= op2` |',
    '| `ult` | Unordered or `op1 < op2` |',
    '| `ule` | Unordered or `op1 <= op2` |',
    '| `une` | Unordered or `op1 != op2` |',
    '| `uno` | At least one operand is NaN |',
    '| `true` | Always |',
    '',
    'Scalar operands produce `i1`; vectors compare corresponding lanes and produce an `i1` vector with the same lane count. Optional fast-math flags impose their own assumptions on inputs.'
  ].join('\n')
};

const instructions = {
  ret: ['Returns control to the caller, optionally with a value matching the function return type.', 'ret <type> <value> | ret void'],
  br: ['Transfers control to one block, or chooses between two blocks using an i1 condition.', 'br label <dest> | br i1 <cond>, label <yes>, label <no>'],
  switch: ['Selects a destination by comparing an integer against constant cases; otherwise branches to the default block.', 'switch <inttype> <value>, label <default> [ <inttype> <case>, label <dest> ... ]'],
  indirectbr: ['Branches to a computed block address. Every possible target must appear in the destination list.', 'indirectbr ptr <address>, [label <dest>, ...]'],
  invoke: ['Calls a function and ends the block with separate destinations for normal return and exception unwinding.', '<result> = invoke <type> <callee>(<args>) to label <normal> unwind label <exception>'],
  callbr: ['Calls inline assembly or a supported intrinsic with a fallthrough destination and explicit indirect destinations.', '<result> = callbr <type> <callee>(<args>) to label <fallthrough> [label <indirect>, ...]'],
  resume: ['Continues unwinding an exception using the exception aggregate produced by a landingpad.', 'resume <type> <exception>'],
  catchswitch: ['Dispatches exception handling to catchpad handlers within an enclosing exception pad.', '<dispatch> = catchswitch within <parent> [label <handler>, ...] unwind to caller'],
  catchret: ['Leaves a catchpad and resumes ordinary control flow at its successor block.', 'catchret from <catchpad> to label <next>'],
  cleanupret: ['Finishes a cleanuppad and continues unwinding to another exception pad or the caller.', 'cleanupret from <cleanuppad> unwind to caller'],
  unreachable: ['Ends a block on a path that must never execute; reaching this instruction is undefined behavior.', 'unreachable'],
  fneg: ['Flips the sign of a floating-point value, including signed zero; also supports vectors.', '<result> = fneg <type> <value>'],
  extractelement: ['Reads one vector lane at a runtime integer index. An out-of-range index produces poison.', '<result> = extractelement <vector-type> <vector>, <inttype> <index>'],
  insertelement: ['Produces a vector with one lane replaced. An out-of-range index produces poison.', '<result> = insertelement <vector-type> <vector>, <element-type> <value>, <inttype> <index>'],
  shufflevector: ['Builds a vector by selecting lanes from two input vectors using a constant shuffle mask.', '<result> = shufflevector <vector-type> <op1>, <vector-type> <op2>, <mask-type> <mask>'],
  extractvalue: ['Reads a field of a struct or array aggregate using constant indices; it does not access memory.', '<result> = extractvalue <aggregate-type> <aggregate>, <index>, ...'],
  insertvalue: ['Produces a struct or array aggregate with the indexed field replaced; indices are constants.', '<result> = insertvalue <aggregate-type> <aggregate>, <type> <value>, <index>, ...'],
  alloca: ['Allocates stack storage and returns its pointer. Storage is reclaimed when the function returns.', '<result> = alloca <type>, <inttype> <count>, align <alignment>'],
  load: ['Reads a typed value from a pointer. The access type is written explicitly, including with opaque pointers.', '<result> = load <type>, ptr <address>, align <alignment>'],
  store: ['Writes a typed value to memory through a pointer; produces no SSA result.', 'store <type> <value>, ptr <address>, align <alignment>'],
  fence: ['Establishes memory ordering between atomic operations according to its ordering and synchronization scope.', 'fence [syncscope("<scope>")] <ordering>'],
  cmpxchg: ['Atomically compares memory with an expected value and conditionally replaces it. Returns { old value, i1 success }.', '<result> = cmpxchg ptr <address>, <type> <expected>, <type> <replacement> <success-order> <failure-order>'],
  atomicrmw: ['Atomically reads, updates, and writes a memory location, returning its previous value.', '<result> = atomicrmw <operation> ptr <address>, <type> <value> <ordering>'],
  getelementptr: ['Computes an address from a source element type and indices without reading memory. The first index steps through source elements.', '<result> = getelementptr <source-type>, ptr <base>, <inttype> <index>, ...'],
  icmp: ['Compares integers or pointers using the chosen predicate, producing i1 or a vector of i1.', '<result> = icmp <cond> <ty> <op1>, <op2>\n<result> = icmp samesign <cond> <ty> <op1>, <op2>'],
  fcmp: ['Compares floating-point values, producing i1 or a vector of i1. Ordered predicates exclude NaNs; unordered predicates include NaN cases.', '<result> = fcmp [<fast-math-flags>] <cond> <ty> <op1>, <op2>'],
  phi: ['Merges SSA values at a block entry: provide an incoming value/block pair for every predecessor. Phi instructions must precede non-phi instructions.', '<result> = phi <type> [ <op1>, <pred1> ], [ <op2>, <pred2> ]'],
  select: ['Chooses a value using an i1 condition, or chooses lanes using a vector condition, without transferring control.', '<result> = select i1 <condition>, <type> <yes>, <type> <no>'],
  freeze: ['Replaces undef or poison with an arbitrary fixed value. Every use of the same result observes that value; defined inputs pass through.', '<result> = freeze <type> <value>'],
  call: ['Calls a function with typed arguments. A non-void return value may be assigned to an SSA name.', '<result> = call <return-type> <callee>(<typed-arguments>)'],
  va_arg: ['Reads the next argument from a variable-argument list and advances the list state.', '<result> = va_arg ptr <list>, <type>'],
  landingpad: ['Begins an exception landing block and obtains exception data. Catch/filter clauses and cleanup describe handling under the function personality.', '<exception> = landingpad <result-type> [cleanup] [catch <type> <value> | filter <array-type> <value>] ...'],
  catchpad: ['Begins a catch handler under a catchswitch, producing a token for the exception funclet.', '<pad> = catchpad within <dispatch> [<typed-arguments>]'],
  cleanuppad: ['Begins an exception cleanup funclet, producing a token used to identify the enclosing cleanup.', '<pad> = cleanuppad within <parent> [<typed-arguments>]']
};
for (const [name, [summary, syntax]] of Object.entries(instructions)) {
  add(name, 'instruction', summary, `${name.replace('_', '-')}-instruction`, syntax, comparisonDetails[name]);
}

const binary = {
  add: 'Adds integers modulo the type width unless no-wrap flags impose stronger requirements.',
  sub: 'Subtracts integers modulo the type width unless no-wrap flags impose stronger requirements.',
  mul: 'Multiplies integers modulo the type width unless no-wrap flags impose stronger requirements.',
  udiv: 'Divides unsigned integers. A zero divisor is undefined behavior.',
  sdiv: 'Divides signed integers, rounding toward zero. Division by zero and signed division overflow are undefined behavior.',
  urem: 'Computes the unsigned integer remainder. A zero divisor is undefined behavior.',
  srem: 'Computes the signed remainder, with the dividend sign. A zero divisor or signed division overflow is undefined behavior.',
  shl: 'Shifts integer bits left and fills low bits with zero. A shift amount at least the bit width produces poison.',
  lshr: 'Shifts integer bits right and fills high bits with zero. An excessive shift amount produces poison.',
  ashr: 'Shifts integer bits right and copies the sign bit into high bits. An excessive shift amount produces poison.',
  and: 'Computes bitwise conjunction of integer operands.',
  or: 'Computes bitwise inclusive OR of integer operands.',
  xor: 'Computes bitwise exclusive OR of integer operands.',
  fadd: 'Adds floating-point operands using the applicable floating-point semantics.',
  fsub: 'Subtracts floating-point operands using the applicable floating-point semantics.',
  fmul: 'Multiplies floating-point operands using the applicable floating-point semantics.',
  fdiv: 'Divides floating-point operands; unlike integer division, floating-point division can produce infinities or NaNs.',
  frem: 'Computes a floating-point remainder using a quotient truncated toward zero, as in fmod.'
};
for (const [name, summary] of Object.entries(binary)) {
  add(name, 'instruction', summary + ' Scalar and vector forms are supported.', `${name}-instruction`, `<result> = ${name} <type> <op1>, <op2>`);
}

const conversions = {
  trunc: 'Narrows an integer by discarding high bits.',
  zext: 'Widens an integer by filling new high bits with zero.',
  sext: 'Widens an integer by copying its sign bit into new high bits.',
  fptrunc: 'Converts to a narrower floating-point format, possibly losing precision.',
  fpext: 'Converts to a wider floating-point format.',
  fptoui: 'Converts floating-point to unsigned integer, rounding toward zero. An unrepresentable result produces poison.',
  fptosi: 'Converts floating-point to signed integer, rounding toward zero. An unrepresentable result produces poison.',
  uitofp: 'Converts an unsigned integer to floating-point, possibly rounding.',
  sitofp: 'Converts a signed integer to floating-point, possibly rounding.',
  ptrtoint: 'Converts pointer representation bits to an integer, truncating or zero-extending as needed. Non-integral pointers have additional restrictions.',
  inttoptr: 'Converts an integer to a pointer representation, truncating or zero-extending as needed. This alone does not guarantee a dereferenceable pointer.',
  bitcast: 'Reinterprets a value without changing its bits. Source and destination must satisfy equal-size and pointer restrictions.',
  addrspacecast: 'Converts a pointer between address spaces when the target supports that conversion; the representation may change.'
};
for (const [name, summary] of Object.entries(conversions)) {
  add(name, 'instruction', summary, `${name}-to-instruction`, `<result> = ${name} <source-type> <value> to <destination-type>`);
}

function group(kind, anchor, definitions) {
  for (const [name, summary] of Object.entries(definitions)) add(name, kind, summary, anchor);
}

group('keyword', 'call-instruction', {
  tail: 'Marks a call as eligible for tail-call treatment subject to target and calling-convention rules; it does not always guarantee elimination of the caller frame.',
  musttail: 'Requires a tail call. The call and following return must satisfy strict signature, calling-convention, and ABI compatibility rules.',
  notail: 'Prevents this call from being optimized into a tail call.'
});
add('unwind', 'keyword', 'Introduces the exceptional destination of invoke or exception-handling terminators. It is not a standalone instruction in modern LLVM IR.', 'terminator-instructions');

group('type', 'floating-point-types', {
  half: 'IEEE binary16 floating-point type, occupying 16 bits.',
  bfloat: '16-bit floating-point format with the exponent range of float and reduced significand precision.',
  float: 'IEEE binary32 floating-point type, occupying 32 bits.',
  double: 'IEEE binary64 floating-point type, occupying 64 bits.',
  fp128: 'IEEE binary128 floating-point type, occupying 128 bits.',
  x86_fp80: '80-bit extended floating-point type used by x87.',
  ppc_fp128: '128-bit floating-point format represented as a pair of doubles.'
});
for (const [name, summary, anchor] of [
  ['void', 'Indicates that a function or instruction returns no value; it cannot describe an ordinary SSA value.', 'void-type'],
  ['ptr', 'Opaque pointer type: the pointee type is not encoded in ptr. Loads, stores, and getelementptr specify access or element types separately. An optional addrspace(N) selects an address space; older IR may use typed pointers such as i32*.', 'pointer-type'],
  ['label', 'Type of a basic-block reference used by branches, phi nodes, and other control-flow instructions.', 'label-type'],
  ['token', 'Special value type used to associate operations such as exception pads; it cannot be freely manipulated as an integer.', 'token-type'],
  ['metadata', 'Type used for metadata operands, including debugging and optimization information.', 'metadata-type'],
  ['opaque', 'Declares an identified struct whose body is unspecified; its layout and size are unavailable.', 'opaque-structure-types'],
  ['x86_amx', 'Target-specific value type for an x86 AMX tile register.', 'x86-amx-type'],
  ['x86_mmx', 'Legacy target-specific 64-bit MMX register type found in older LLVM IR.', 'type-system']
]) add(name, 'type', summary, anchor);

group('keyword', 'simple-constants', {
  true: 'Boolean constant equal to i1 1. As an fcmp predicate, true always succeeds.',
  false: 'Boolean constant equal to i1 0. As an fcmp predicate, false always fails.',
  null: 'Null pointer constant in the specified pointer type and address space.',
  none: 'The token constant used when no enclosing exception pad exists; also used in attributes such as memory(none).',
  undef: 'Unspecified value whose different uses may observe different choices; it is not a stable arbitrary value.',
  poison: 'Deferred invalid value that generally propagates through computations and can cause undefined behavior when consumed by certain operations.',
  zeroinitializer: 'Initializes a scalar or aggregate to its all-zero value, including recursively zeroing aggregate elements.'
});

group('keyword', 'functions', {
  define: 'Defines a function, including its return type, parameters, optional attributes, and body of basic blocks.',
  declare: 'Declares a function signature without a body so that calls can refer to an externally provided implementation.',
  personality: 'Attaches the runtime personality routine that interprets exception-handling information for a function.',
  gc: 'Selects a garbage-collection strategy for a function.',
  prefix: 'Places constant data immediately before a function entry, according to the prefix-data rules.',
  prologue: 'Attaches constant prologue data to the beginning of a function.'
});
group('keyword', 'global-variables', {
  global: 'Declares or defines a module-level variable whose stored value may change.',
  constant: 'Declares or defines a global whose stored value does not change during program execution.',
  align: 'Specifies a power-of-two byte alignment on storage, a memory access, or a pointer parameter; its exact guarantee depends on context.',
  section: 'Places a global object or function in a named object-file section.',
  unnamed_addr: 'States that a global object address is insignificant, permitting merging of equivalent objects.',
  local_unnamed_addr: 'States that a global object address is insignificant within this module.',
  externally_initialized: 'Prevents the optimizer from assuming a global retains its initializer before global initialization executes.'
});
for (const [name, summary, anchor] of [
  ['source_filename', 'Records the original source filename associated with this module.', 'source-filename'],
  ['target', 'Introduces target information such as the module data layout or target triple.', 'module-structure'],
  ['datalayout', 'Describes target data representation, including endianness, pointer layouts, and alignments; used by optimizations and code generation.', 'data-layout'],
  ['triple', 'Identifies the target architecture, vendor, operating system, and environment.', 'target-triple'],
  ['type', 'Defines a named, identified structure type, including recursive or opaque structures.', 'structure-type'],
  ['attributes', 'Defines a reusable numbered attribute group referenced by functions or call sites.', 'attribute-groups'],
  ['alias', 'Introduces another global name for an existing global value or constant expression.', 'aliases'],
  ['ifunc', 'Defines an indirect function whose runtime resolver selects the implementation.', 'ifuncs'],
  ['comdat', 'Associates global objects with a linker selection group to control duplicate definitions.', 'comdats'],
  ['module', 'Used with asm to attach module-level assembly text.', 'module-level-inline-assembly'],
  ['asm', 'Introduces an inline assembly expression or module-level assembly.', 'inline-assembler-expressions'],
  ['sideeffect', 'Marks inline assembly as having side effects even when its outputs are unused.', 'inline-assembler-expressions'],
  ['inteldialect', 'Selects the Intel assembly dialect for an inline assembly expression.', 'inline-assembler-expressions'],
  ['addrspace', 'Selects a numbered pointer or object address space whose meaning depends on the target.', 'pointer-type'],
  ['blockaddress', 'Forms a constant address of a basic block in a named function for indirect control flow.', 'addresses-of-basic-blocks'],
  ['distinct', 'Creates a distinct metadata node that is not structurally uniqued with equal nodes.', 'metadata'],
  ['vscale', 'Marks a scalable vector whose runtime lane count is a fixed positive multiple of the written minimum.', 'vector-type'],
  ['to', 'Separates source and destination types in conversions, or introduces a control-flow destination.', 'instruction-reference'],
  ['within', 'Identifies an enclosing exception-handling pad, or none at the outermost level.', 'catchswitch-instruction'],
  ['cleanup', 'Marks a landingpad as requiring cleanup during exception unwinding.', 'landingpad-instruction'],
  ['filter', 'Introduces a landingpad filter clause containing an array of exception type descriptors.', 'landingpad-instruction']
]) add(name, 'keyword', summary, anchor);

group('keyword', 'linkage-types', {
  private: 'Makes a global value visible only within its module and omits its symbol from the object-file symbol table.',
  internal: 'Makes a global value local to its module, typically corresponding to a local object-file symbol.',
  external: 'Uses an externally visible definition, or declares a definition provided elsewhere.',
  available_externally: 'Supplies a body for optimization without emitting its definition into this module object file.',
  linkonce: 'Allows the linker to merge duplicate definitions and discard unreferenced copies.',
  linkonce_odr: 'Allows merging equivalent definitions under the one-definition rule and discarding unreferenced copies.',
  weak: 'Allows linker merging of weak definitions, while retaining definitions that may be externally needed.',
  weak_odr: 'Weak linkage with a promise that merged definitions are equivalent under the one-definition rule.',
  common: 'Represents a tentative zero-initialized global definition that the linker may merge.',
  appending: 'Combines compatible global arrays by concatenating their elements during linking.',
  extern_weak: 'Declares a weak external symbol that may resolve to null when no definition is available.'
});
group('keyword', 'calling-conventions', {
  ccc: 'Uses the target C calling convention; this is the default calling convention.',
  fastcc: 'Uses an LLVM convention intended for efficient internal calls; caller and callee must agree.',
  coldcc: 'Uses a convention intended for infrequently called functions.',
  tailcc: 'Uses a calling convention designed to support tail-call optimization.',
  cc: 'Introduces a numeric calling-convention identifier. Its meaning depends on the LLVM target and convention table.'
});

group('attribute', 'function-attributes', {
  alwaysinline: 'Requests inlining whenever legal, overriding normal size-based inlining heuristics.',
  noinline: 'Prevents the function from being considered for inlining.',
  inlinehint: 'Suggests that inlining this function is desirable, without requiring it.',
  optnone: 'Disables most optimizations for the function; requires noinline and has attribute compatibility restrictions.',
  optsize: 'Favors reduced code size while applying optimizations.',
  minsize: 'Requests stronger optimization for minimum code size.',
  nounwind: 'Promises that the function does not unwind exceptions.',
  noreturn: 'Promises that the function never returns normally to its caller; it may still unwind.',
  willreturn: 'Promises the call returns to its caller within a finite time or has undefined behavior; this does not imply nounwind.',
  mustprogress: 'Requires the function to return, unwind, or make observable progress rather than loop forever without observable effects.',
  norecurse: 'Promises the function does not participate in direct or indirect recursion.',
  nosync: 'Promises the function does not synchronize with another thread through memory or other recognized mechanisms.',
  nofree: 'Promises the function does not free memory allocated before its invocation.',
  nocallback: 'Promises the function does not call back into the calling module.',
  cold: 'Marks a function or call site as rarely executed to guide optimization.',
  hot: 'Marks a function as frequently executed to guide optimization.',
  memory: 'Describes permitted memory effects, for example memory(none) or memory(argmem: read).',
  readnone: 'Legacy function memory-effect attribute forbidding memory access; pointer-parameter use has its own scope. Modern function IR uses memory(none).',
  readonly: 'Restricts memory access to reads; on a pointer parameter this applies to memory accessed through that argument. Modern function effects use memory(read).',
  writeonly: 'Restricts memory access to writes; parameter and function uses have different scope. Modern function effects use memory(write).',
  argmemonly: 'Legacy function attribute restricting memory accesses to argument-based locations; modern IR uses memory(argmem: readwrite).',
  speculatable: 'Allows speculative execution subject to its memory and operand constraints; promises no relevant undefined behavior or side effects.',
  strictfp: 'Preserves strict floating-point behavior when used with constrained floating-point operations.',
  uwtable: 'Requests generation of unwind-table information for the function.',
  ssp: 'Requests stack protection for functions meeting the stack-protector criteria.',
  sspstrong: 'Requests stronger stack-protector coverage than ssp.',
  sspreq: 'Requires stack-protector instrumentation.',
  sanitize_address: 'Enables AddressSanitizer instrumentation for the function.',
  sanitize_thread: 'Enables ThreadSanitizer instrumentation for the function.',
  sanitize_memory: 'Enables MemorySanitizer instrumentation for the function.',
  null_pointer_is_valid: 'Makes address-space-zero null pointers valid for memory access in this function.',
  convergent: 'Restricts transformations that change which threads participate together in convergent operations.',
  noduplicate: 'Prevents transformations from duplicating calls to the function.',
  naked: 'Suppresses compiler-generated function prologue and epilogue, with target-specific body restrictions.'
});
group('attribute', 'parameter-attributes', {
  zeroext: 'Requires ABI zero extension of the integer argument or return value to the target-required width.',
  signext: 'Requires ABI sign extension of the integer argument or return value to the target-required width.',
  inreg: 'Requests target-specific register passing behavior for a parameter or return value.',
  byval: 'Passes a pointer to a hidden copy of an aggregate; the attribute type describes the copied object.',
  byref: 'Describes a referenced argument memory type without the implicit copy required by byval.',
  sret: 'Marks a pointer parameter as the location where the callee writes its aggregate return value.',
  noalias: 'Promises restricted aliasing for accesses through an argument; on a return value it provides an allocation-like disjointness guarantee.',
  nocapture: 'Legacy promise that a pointer argument is not captured beyond the call; newer IR can describe captures more precisely.',
  captures: 'Specifies which parts of a pointer argument may be captured, such as captures(none).',
  nonnull: 'Promises a pointer is not null; a violation produces poison and requires additional constraints such as noundef for immediate undefined behavior.',
  noundef: 'Requires every value bit to be defined, excluding undef and poison at the call boundary.',
  dereferenceable: 'Promises the pointer can be safely read for the specified number of bytes without trapping.',
  dereferenceable_or_null: 'Promises a pointer is either null or dereferenceable for the specified number of bytes.',
  returned: 'Promises the function returns this argument value, subject to the permitted return-type conversion.',
  immarg: 'Requires an intrinsic argument to be an immediate constant of the permitted form.',
  inalloca: 'Passes arguments in a caller-allocated stack block with special lifetime and calling restrictions.',
  preallocated: 'Describes an argument passed in preallocated storage coordinated with the preallocated intrinsics and operand bundle.',
  elementtype: 'Supplies the pointee type required by particular intrinsics when using opaque pointers.',
  nest: 'Identifies the parameter used to pass a nested-function environment.',
  swiftself: 'Marks the Swift self/context parameter for the target ABI.',
  swifterror: 'Marks storage or a parameter used for the Swift error result convention.'
});

group('keyword', 'fast-math-flags', {
  nnan: 'Allows assuming floating-point arguments and results are not NaN; violating this promise produces poison.',
  ninf: 'Allows assuming floating-point arguments and results are not infinite; violating this promise produces poison.',
  nsz: 'Allows treating the signs of floating-point zero as insignificant.',
  arcp: 'Allows reciprocal-based rewrites of floating-point division.',
  contract: 'Allows contracting floating-point operations, such as a multiply and add, into a fused operation.',
  afn: 'Allows approximate implementations of floating-point functions.',
  reassoc: 'Allows reassociation of floating-point operations, which may change rounding.',
  fast: 'Enables all fast-math flags on a supported floating-point operation.'
});
for (const [name, summary, anchor] of [
  ['nsw', 'Promises no signed overflow for the integer operation; violating the promise produces poison.', 'poison-values'],
  ['nuw', 'Promises no unsigned overflow for the integer operation; violating the promise produces poison.', 'poison-values'],
  ['exact', 'Requires integer division to have no remainder, or a right shift to discard only zero bits; otherwise the result is poison.', 'poison-values'],
  ['disjoint', 'Promises the operands of or have no common set bits; violating this promise produces poison.', 'or-instruction'],
  ['nneg', 'Promises the operand of a supported conversion is nonnegative; violating this promise produces poison.', 'zext-to-instruction'],
  ['samesign', 'Promises the icmp operands have the same sign; otherwise its result is poison.', 'icmp-instruction'],
  ['inbounds', 'Adds object-bounds and arithmetic constraints to getelementptr; violating them produces poison. It does not make the resulting address safe to dereference.', 'getelementptr-instruction'],
  ['inrange', 'Restricts permitted uses of a getelementptr constant expression result to the specified byte range.', 'getelementptr-instruction'],
  ['volatile', 'Preserves the number and relative order of volatile accesses; does not itself provide thread synchronization.', 'volatile-memory-accesses'],
  ['atomic', 'Marks a load or store as atomic and requires a permitted memory ordering.', 'atomic-memory-ordering-constraints'],
  ['syncscope', 'Limits the scope in which an atomic operation synchronizes, using a target-defined scope name.', 'atomic-memory-ordering-constraints'],
  ['singlethread', 'Synchronization scope restricting an atomic operation to the current thread, including signal handlers.', 'atomic-memory-ordering-constraints']
]) add(name, 'keyword', summary, anchor);
group('keyword', 'atomic-memory-ordering-constraints', {
  unordered: 'Provides the weakest atomic ordering, without synchronization between threads.',
  monotonic: 'Provides atomic coherence for the accessed location without acquire/release synchronization.',
  acquire: 'Can synchronize with a release operation and prevents following accesses from moving before the acquire.',
  release: 'Can synchronize with an acquire operation and prevents preceding accesses from moving after the release.',
  acq_rel: 'Combines acquire and release ordering for an operation supporting both.',
  seq_cst: 'Adds participation in a single total order of sequentially consistent operations to the applicable acquire/release guarantees.'
});

group('keyword', 'icmp-instruction', {
  eq: 'Integer or pointer equality predicate for icmp.',
  ne: 'Integer or pointer inequality predicate for icmp.',
  sgt: 'Signed greater-than integer predicate.',
  sge: 'Signed greater-than-or-equal integer predicate.',
  slt: 'Signed less-than integer predicate.',
  sle: 'Signed less-than-or-equal integer predicate.'
});
for (const [suffix, relation] of Object.entries({ gt: 'greater than', ge: 'greater than or equal to', lt: 'less than', le: 'less than or equal to' })) {
  add('u' + suffix, 'keyword', `For icmp: unsigned ${relation}. For fcmp: true if either operand is NaN or the first is ${relation} the second.`, 'fcmp-instruction');
}
for (const [suffix, relation] of Object.entries({ eq: 'equal to', gt: 'greater than', ge: 'greater than or equal to', lt: 'less than', le: 'less than or equal to', ne: 'not equal to' })) {
  add('o' + suffix, 'keyword', `Ordered floating-point predicate: true only when neither operand is NaN and the first is ${relation} the second.`, 'fcmp-instruction');
}
group('keyword', 'fcmp-instruction', {
  ord: 'True when neither floating-point operand is NaN.',
  uno: 'True when at least one floating-point operand is NaN.',
  ueq: 'True when either floating-point operand is NaN or the operands are equal.',
  une: 'True when either floating-point operand is NaN or the operands are unequal.'
});

// Common widths are also listed for completion; lookup supports uncommon widths.
function integerEntry(word) {
  return Object.freeze({ kind: 'type', summary: `${word.slice(1)}-bit integer type. Signedness belongs to the operation (for example sdiv versus udiv), not to the type.`, url: base + 'integer-type' });
}
for (const width of [1, 8, 16, 32, 64, 128]) entries['i' + width] = integerEntry('i' + width);
Object.freeze(entries);

function lookup(word) {
  if (typeof word !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(entries, word)) return entries[word];
  if (/^i[1-9][0-9]*$/.test(word) && Number(word.slice(1)) <= 8388607) return integerEntry(word);
  return undefined;
}

module.exports = { entries, lookup };
