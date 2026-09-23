# Changes

## 1.2.7 — working with blocks

- Block labels have their own theme color, `llvmIR.labelForeground`, with bold definitions. VS Code's themes color `entity.name.label` like plain text (`#C8C8C8` in Dark Modern), which hid the block structure of IR.
  - No existing scope colors labels distinctly across the bundled themes, so the extension contributes a color instead.
  - The defaults (`#FFB86C` dark, `#953800` light, `#FFB86C` high contrast, `#8A4600` high contrast light) were checked against all 19 bundled themes for contrast and for distance from the other role colors.
  - Override the color in `workbench.colorCustomizations`, or set `llvmIR.labels.highlight` to `false` to return to the theme's color.
- Label hovers show predecessors, successors, loop headers (`Loop header: %body branches back here.`), the immediate dominator, and entry or unreachable status. Hovering a branch target previews that block.
- Predecessor inlay hints after block labels (`preds: %entry, %body`), each linking to its block. They're skipped where clang already wrote `; preds =`. New setting: `llvmIR.inlayHints.predecessors`.
- New **LLVM IR: Show Control-Flow Graph** command, available from the editor title button, the context menu, and a `Control-flow graph` CodeLens on each function:
  - Blocks are laid out top to bottom, with T/F on conditional branches, dashed back edges routed around blocks, and unreachable blocks dimmed.
  - The current block is highlighted as the cursor moves, and clicking a block jumps to it.
  - Offline, with no remote resources and a strict content security policy.
  - New setting: `llvmIR.codeLens.controlFlowGraph`.

## 1.2.6 — diagnostics without LLVM

- Built-in checks run as you type and need no LLVM installation (`llvmIR.diagnostics.builtIn`):
  - **Errors:**
    - undefined values, labels, types and metadata
    - duplicate definitions
    - numbered values that don't increase
    - blocks without a terminator, and missing or unclosed bodies
    - branches to the entry block or to non-blocks
    - misplaced `phi`s, and `phi` incoming blocks that don't match the predecessors
    - uses not dominated by their definition
    - operand type mismatches, wrong `ret` types and named `void` results
    - swapped `load`/`store` operands and unknown instructions
  - **Warnings:** calls that differ from the callee's declaration, variadic calls without a function type, division by constant zero, code after a terminator, and undefined attribute groups.
  - **Faded hints:** unused values, declarations and private symbols, and unreachable blocks.
- Every built-in error matches a case `llvm-as` rejects. Tests check this against LLVM when it is installed, and clang output at `-O0`–`-O3` with `-g`, C++ exceptions, computed `goto` and atomics stays free of errors and warnings.
- Quick fixes:
  - "Change to `%count`" for misspelled names and opcodes.
  - "Add declaration" for globals defined elsewhere in the workspace.
  - Spelling the function type of variadic calls (`call i32 (ptr, ...) @printf`).
- An error `llvm-as` already reports on a line hides the built-in error there, so each mistake appears once.
- `llvmIR.diagnostics.scope: workspace` runs built-in checks on every indexed file, updating as files change on disk.
- The new **LLVM IR: Verify Workspace** command runs `llvm-as` on every indexed file, with progress and cancellation, and summarizes the failures.
- Faster symbol resolution on large modules: memoized name identities, a per-name index, and binary-searched function scopes.
- Fix: return types preceded by attributes such as `range(i32 0, 10)` are parsed correctly, and `#dbg_value` records no longer merge into the preceding instruction.

## 1.2.5 — context-aware editing

- Completion follows the instruction being written:
  - Only block labels after `label` and in `phi` incoming slots (the entry block is never offered).
  - Only predicates after `icmp`/`fcmp`, with their meanings.
  - Only operands of the expected type that are available at the cursor, meaning parameters and results whose definition dominates the use.
  - `ptr` operands add globals and `null`; `i1` adds `true`/`false`. A call argument without a type completes as `i32 %x`.
  - After `call <type>`, the callee is completed: functions and `ptr` values.
- Workspace completion adds the missing declaration, like an auto-import: `declare void @f(i32 signext)` or `@g = external global i32`. It goes after existing declarations or before the first definition. It is added only when every compatible definition agrees and needs no named types; otherwise only the name is inserted, as before.
- Parameter-name inlay hints at call sites (`@sum(left: i32 2, right: i32 3)`), falling back to library documentation for unnamed declarations (`printf(format: ptr @msg)`). Arguments named like their parameter get no hint. New setting: `llvmIR.inlayHints.parameterNames`.
- `N references` CodeLens above functions, globals, and named types, counting cross-file uses when workspace indexing is on. New setting: `llvmIR.codeLens.references`.

## 1.2.4 — inlay hints on by default

- Enable inlay hints by default (`llvmIR.inlayHints.enabled`); turn them off in settings if unwanted.
- Pointer parameter hints use the same `: type → pointee` form as SSA values, e.g. `ptr %this: ptr → %Class_Dog?`.
- Pointer hovers match the inlay hints: the signature reads `%a_vtbl: ptr → @dogVTBL? = load …`, and each inferred pointee gets one `pointee — reason` line (e.g. `` `@dogVTBL?` — the only address stored to field 0 of `%Class_Dog` (in `@Dog`) ``) in place of the `Stack slot holds`, `Pointer accessed as`, `Address of`, `Likely value`, and `Likely receiver` sentences. Inlay tooltips use the same lines.

## 1.2.3 — consistent hover layout

- Extend the Pylance-style layout to every hover: a `(kind) signature` code block, a divider, then documentation and context.
- Functions, parameters, labels, globals, types, metadata, and attribute groups gain kind prefixes; parameters read `(parameter) %name: type`, and globals `(global) @name: type = ...`.
- Instruction and keyword hovers lead with their syntax (alternative forms as separate lines) instead of the summary.
- Library hovers show `@param`/`@returns` documentation before cross-file locations.
- Pointer hovers follow GEP field addresses, stack-slot loads, object fields holding a single global, and constant tables, resolving hw2-style vtable dispatch to its likely method.
- Vtable methods show a likely receiver type for their first `ptr` parameter.
- Inlay hints append the inferred pointee to pointer types (`: ptr → i32`, `: ptr → @dog_makeNoise?`) and to pointer parameters (`→ %Class_Dog?`); `?` marks hints, and the tooltip gives the same qualified explanation as the hover.

## 1.2.2 — concise variable hovers

- Lead SSA variable hovers with `(variable) %name: type = expression`, matching familiar editor tooltip conventions.
- Keep definition location and qualified stack storage/access details below the signature; show `Unknown` when a result type cannot be inferred.

## 1.2.1 — pointer hover details

- Show the explicit allocated type for `alloca` results, so `alloca ptr` identifies a stack slot that holds a pointer.
- Show a qualified GEP access type when a direct pointer use, call, and single store support it; suppress ambiguous or escaped cases.
- Cover the `hw2/objects.llvm` hover example and conflicting-use cases in regression tests.

## 1.2.0 — workspace navigation and library help

- Add cross-file definitions/references, workspace symbols, and declaration-aware external completion.
- Index unopened `.ll`/`.llvm` files with dirty-buffer precedence, lifecycle generations, multi-root/project isolation, exclusions and resource limits.
- Add conservative atomic rename planning, whole-index freshness preflight, linkage/ABI/target/address-space checks, and refusal of ambiguous or unsupported refactorings.
- Add 20 libc function entries and 24 intrinsic families: useful parameters/returns, printf/scanf format guidance, promotions, memory semantics and LLVM-version caveats.
- Preserve actual source signatures; suppress libc semantics for known user implementations and never synthesize declarations.
- Keep local hover/navigation responsive while workspace discovery runs; correctly map UTF-16 and CR/LF/CRLF locations.
- Add primary-source research reports, unit regressions and isolated real-VS-Code multi-root acceptance tests.

## 1.1.4 — popup readability audit

- Label hovers show their 1-based definition line and containing function.
- Replace generic symbol/type/definition stacks with one preview and useful per-kind context.
- Keep inferred SSA result types explicit; remove meaningless unknown types from metadata, attribute groups, and outline details.
- Deduplicate function signatures in completion documentation and signature help.
- Replace repetitive completion kind labels with type/location context.
- Bound source previews to 10 lines/1000 UTF-16 code units with an explicit truncation notice.
- Test scoped/quoted/numeric labels, moving line numbers, all symbol kinds, completion, outline, and Unicode-safe previews.

## 1.1.3 — concise function tooltips

- Show function signatures once, without a generic function label or repeated definition.
- Preserve calling conventions and parameter/function attributes in the single signature.
- Add exact-output regressions for function tooltips in unit and VS Code host tests.

## 1.1.2 — standard role-based colors

- Use the standard label scope instead of the blue HTML-tag scope.
- Use built-in type and word-operator scopes to separate types, instruction operators, and SSA variables.
- Keep color selection with the active theme; no forced theme or user-settings mutation.
- Verify actual Dark Modern and Light Modern colors and semantic label fallback in extension-host tests.

## 1.1.1 — label readability and instruction reference

- Give label definitions and references matching theme-aware colors, including quoted and numeric labels.
- Fold labeled basic blocks independently within functions.
- Use angle-bracket placeholders in instruction hover syntax.
- Include full integer and floating-point comparison predicate tables and explain `icmp samesign`.
- Add real TextMate tokenization tests and extend VS Code host regression checks.

## 1.1.0 — local language tools fork

- Add language analysis and editor providers on top of the original grammar.
- Add optional type hints and LLVM verification.
- Add unit tests, a VS Code host smoke test, and VSIX packaging.
- Use local identity `cse4100-local.llvm-ir-highlighter`.

## 1.0.0 — original highlighter

- Declarative syntax highlighting and editor configuration by Leo Pagano.
