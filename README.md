# LLVM IR Language Tools (Local)

A local extension for editing LLVM IR, built on the original LLVM IR Highlighter
grammar. Supports `.ll` and `.llvm`. Extension ID: `cse4100-local.llvm-ir-highlighter`.

## Features

- Hovers follow the Python/Pylance layout: a `(kind) signature` code block, a divider, then documentation and context. Kinds are `function`, `parameter`, `variable`, `label`, `global`, `type`, `metadata`, `attributes`, `instruction`, `keyword`, and `attribute`.
- Hover SSA values as `(variable) %name: type = expression` and parameters as `(parameter) %name: type`, with the definition line and owning function below the divider.
- Pointer hovers and inlay hints show what an opaque `ptr` refers to, as `ptr → pointee`. A trailing `?` marks a hint inferred from uses rather than stated by the instruction, and the hover adds one `pointee — reason` line for it:
  - GEP results address a member: `%t1: ptr → i32`, with `` `i32` — field 1 of `%Class_Dog` ``.
  - Stack slots show what they hold: `%a_ptr: ptr → ptr → %Class_Dog?`.
  - Pointers take the type a GEP indexes them as, including through a direct call or a stack slot: `%a_obj: ptr → %Class_Dog?`.
  - A load from an object field whose only stored value is a global's address points to that global (`%a_vtbl: ptr → @dogVTBL?`), and a load from a constant table resolves the entry (`%a.makeNoise_method: ptr → @dog_makeNoise?`), so indirect vtable calls name their likely target. `→ @g` means the pointer holds the address of `@g`; it never means the value is `@g`'s contents.
  - The first `ptr` parameter of a function listed in such a table (a vtable method) shows its likely receivers: `%this: ptr → %Class_Animal | %Class_Dog?`.
- Label hovers give the block's predecessors, successors, loop role (`Loop header: %body branches back here.`) and immediate dominator; hovering a branch target also previews that block.
- **LLVM IR: Show Control-Flow Graph** (editor title button, context menu, or the `Control-flow graph` CodeLens above each function) opens a graph of the function's blocks that follows the cursor. T/F mark conditional edges, dashed edges loop back, unreachable blocks are dimmed, and clicking a block jumps to it.
- Predecessor inlay hints after each block label (`preds: %entry, %body`), each clickable, unless a clang `; preds` comment is already there.
- Hover globals (`(global) @name: type = ...`), named types, metadata, and attribute groups for one source preview and location.
- Hover functions for a single `(function)` signature with return/parameter types, names, attributes, and variadic arguments—without a repeated `define`/`declare`.
- Hover instructions for their operand syntax as the signature (alternative forms on separate lines), followed by an explanation and LLVM reference link. Comparison hovers include all `icmp`/`fcmp` predicates and their meanings.
- Library hovers list `@param` and `@returns` documentation, notes, and a reference link, then any cross-file declaration/definition locations.
- Context-aware completion: block labels after `label` and in `phi` incoming slots (never the entry block), predicates after `icmp`/`fcmp`, and operands that match the expected type and are available in SSA form (parameters and results whose definition dominates the use). Call arguments without a type complete as `i32 %x`. Elsewhere, local symbols and LLVM keywords are offered.
- Completing a symbol from another workspace file adds the matching `declare` (or `@g = external global …`) line, like an auto-import. The declaration is copied from the definition. It is added only when every compatible definition agrees and needs no named types; otherwise only the name is inserted.
- Signature help when entering arguments to known functions.
- Go to definition, find references, highlight occurrences, and rename named symbols.
- Navigate declarations to compatible definitions in other files, find cross-file references, and search workspace symbols.
- Conservative cross-file rename with linkage, ambiguity, ABI, collision, and stale-file checks.
- Offline documentation for 20 C-library functions (including `printf`) and 24 LLVM intrinsic families, with format guidance and parameter help.
- Document outline, function/basic-block folding, and conservative indentation formatting.
- Parameter-name inlay hints before call arguments (`call i32 @sum(left: i32 2, right: i32 3)`), from the callee's parameter names or, for unnamed library declarations such as `declare i32 @printf(ptr, ...)`, the documented names. Arguments already named like the parameter get no hint.
- A reference-count CodeLens (`N references`) above functions, globals, and named types. Counts include other workspace files when indexing is enabled; click to peek them.
- Semantic symbol coloring and SSA type inlay hints (on by default; disable with `llvmIR.inlayHints.enabled`). Pointer hints append their inferred pointee (`: ptr → i32`, `: ptr → ptr → %Class_Dog?` for a slot, `: ptr → @dog_makeNoise?`, `ptr %this: ptr → %Class_Dog?`). A trailing `?` marks a hint inferred from uses rather than stated by the instruction; the tooltip gives the qualified explanation.
- Built-in diagnostics while you type, with no LLVM installation needed (see [Built-in diagnostics](#built-in-diagnostics)), plus quick fixes for misspelled names, missing declarations and variadic calls.
- Verify current, including unsaved, IR with `llvm-as` in the Problems panel, or every indexed file with **LLVM IR: Verify Workspace**.
- The language status area (`{}` in the status bar) shows the `llvm-as` version, why verification is unavailable, and whether the workspace index is complete. **LLVM IR: Check LLVM Toolchain** checks `llvm-as` again.

Block labels get their own themeable color (`llvmIR.labelForeground`), with
definitions in bold, including quoted and numeric labels. Each labeled basic block folds independently, leaving its label
visible. TextMate highlighting, brackets, comments, and region folding remain.
Editing features work offline without LLVM installed. This version executes local
JavaScript to provide language services.

## Install

From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run package
code --install-extension ./llvm-ir-language-tools-1.2.8.vsix
```

Alternatively use **Extensions → … → Install from VSIX**. Disable
`qiu.llvm-ir-language-support` and any original `leoapagano.llvm-ir-highlighter`
in this workspace, then reload. They register the same language and can supply
competing providers or grammars.

Merge this association into your existing workspace settings:

```json
{
  "files.associations": {
    "*.llvm": "llvm-ir"
  }
}
```

An existing association to `"llvm"` overrides recognition: `llvm` is an alias,
whereas `llvm-ir` is the registered language ID.

Open `samples/language-features.ll` to try the new features. The original
`samples/example.ll` remains a highlighting fixture, not a compiler-validity test.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `llvmIR.llvmAsPath` | `llvm-as` | Compiler executable matching your project's LLVM version |
| `llvmIR.diagnostics.enabled` | `true` | Automatically verify edited documents with `llvm-as` |
| `llvmIR.diagnostics.builtIn` | `true` | Built-in checks that need no LLVM installation |
| `llvmIR.diagnostics.scope` | `openFiles` | `workspace` also runs built-in checks on every indexed file |
| `llvmIR.diagnostics.delay` | `600` | Delay after edits, in milliseconds |
| `llvmIR.diagnostics.timeout` | `5000` | Compiler timeout, in milliseconds |
| `llvmIR.inlayHints.enabled` | `true` | Inferred types at SSA definitions and pointer pointees |
| `llvmIR.inlayHints.parameterNames` | `true` | Parameter names before call arguments |
| `llvmIR.inlayHints.predecessors` | `true` | `preds: …` after block labels |
| `llvmIR.labels.highlight` | `true` | Color labels with `llvmIR.labelForeground` and bold their definitions |
| `llvmIR.codeLens.controlFlowGraph` | `true` | `Control-flow graph` link above each function |
| `llvmIR.codeLens.references` | `true` | Reference counts above functions, globals and types |
| `llvmIR.semanticHighlighting.enabled` | `true` | Color resolved symbols by role |
| `llvmIR.libraryHelp.enabled` | `true` | Curated libc and intrinsic help |
| `llvmIR.workspace.enabled` | `true` | Index workspace IR files |
| `llvmIR.workspace.include` | `**/*.{ll,llvm}` | Included files |
| `llvmIR.workspace.exclude` | `**/{.git,node_modules,.vscode-test,build,dist,out}/**` | Excluded files |
| `llvmIR.workspace.maxFiles` | `500` | File limit per workspace folder |
| `llvmIR.workspace.maxFileBytes` | `2097152` | Byte limit per indexed file |
| `llvmIR.workspace.maxTotalBytes` | `33554432` | Source-byte limit per workspace folder |
| `llvmIR.workspace.projectRoots` | `[]` | Independent linkage projects within a workspace folder |

## Cross-file support and library help

The index discovers unopened `.ll` and `.llvm` files and follows edits, saves,
creates, deletions, and configuration changes. Unsaved buffers take precedence
over disk. Each workspace folder is a separate linkage scope; private/internal
symbols, local values, numbered globals, named types, labels, and metadata do not
gain cross-module identity just because their names match. Workspace symbol search
can still list separate module-local definitions.

For unrelated assignments or programs under one folder, merge this setting with
your existing configuration, choosing the actual independent directories:

```json
{
  "llvmIR.workspace.projectRoots": ["hw0", "hw1", "hw2"]
}
```

The longest matching directory wins; files outside those subdirectories remain
in the workspace folder's own scope. This is a configured scope, **not a discovered
linker/build graph**. A `declare` can navigate to a compatible implementation;
multiple implementations are returned as candidates, not arbitrarily selected.
Workspace completion adds a declaration only when it can be copied exactly: every
compatible definition must produce the same declaration, with no named (`%T`)
types and no alias. C-library help never generates declarations, because the
target ABI decides them. Parameter types and signature help continue to come from
the current module's actual IR.

Run **LLVM IR: Reindex Workspace** after changing the indexing scope or resolving
a limit/read failure. The Output channel explains incomplete indexing. Boolean
`files.exclude` and `search.exclude` patterns also apply; conditional sibling
exclusions are not implemented. Excluded/outside/untitled files retain isolated
editing, but cannot establish external rename completeness. Remote/virtual URIs
use VS Code's filesystem API; there is no filesystem-only language restriction.

External rename requires one strong definition, compatible signatures/targets,
a complete configured index, no collisions, and fresh source snapshots. It refuses
weak/ODR/replaceable definitions, external-only APIs, reserved `llvm.*` names,
unsupported named-type/attribute-group ABI comparisons, aliases/ifunc identities,
COMDAT, symbol-bearing assembly/linker options, and matching debug linkage strings.
Different or partially specified target triples/data layouts are conservative
compatibility failures. This can reject a valid rename rather than silently omit
uncertain references. Review the edit preview: excluded files, external consumers,
build scripts and binary libraries are outside the index, and concurrent external
writes cannot be locked by this extension.

Hover a compatible `declare @printf` or its calls for return behavior, parameters,
conversion/length/flag tables, C vararg promotions, and target-ABI cautions.
Library help is qualified documentation, not proof that the linker selects libc;
a known workspace implementation suppresses the annotation. Intrinsic overloads
are matched conservatively, including supported typed/opaque pointer and vector
spellings, with version notes. No network requests occur at runtime.

No automatic declarations, libc source download/navigation, format-string
validation, or automatic linking are provided. The catalog is intentionally finite.
See the bundled `research-existing-lsps.md` and `research-library.md` reports
for primary sources and niche cases.

## Colors and verification

Semantic highlighting defaults on for LLVM IR.

### Label color

VS Code's themes color labels (`entity.name.label`) like plain text: `#C8C8C8` in
Dark Modern and black in Light Modern. The same convention applies to C/C++, C#,
JavaScript, and Go labels, where `goto` targets are rare. In IR, every block starts with a label and
every `br` and `phi` names one, so the extension gives them a theme color of their own,
`llvmIR.labelForeground`, and bolds definitions. Its defaults were chosen against all 19 bundled
themes. Each has at least 6.8:1 contrast and stays clearly distinct from the function, type,
variable, instruction, number, and string colors:

| Theme kind | Default |
| --- | --- |
| Dark | `#FFB86C` |
| Light | `#953800` |
| High contrast | `#FFB86C` |
| High contrast light | `#8A4600` |

Change it like any theme color, or set `llvmIR.labels.highlight` to `false` to fall back to
the theme's own label color and `label:llvm-ir` semantic rules:

```json
{
  "workbench.colorCustomizations": { "llvmIR.labelForeground": "#C586C0" }
}
```

Explicitly disabling `editor.semanticHighlighting.enabled` or the extension's
semantic setting leaves grammar-only highlighting, which cannot resolve every
label reference. Folding requires `editor.foldingStrategy` to be `auto` (the default).

Color roles follow TextMate/VS Code conventions; there is no universal fixed
palette across themes. Built-in types use `support.type`, word-form instruction
operators use `keyword.other.operator`, control flow uses `keyword.control`,
and labels use `entity.name.label` (not the HTML-tag scope), recolored by
`llvmIR.labelForeground` as above. In Dark Modern this separates instruction operators
(purple), types (teal), functions (yellow), variables (light blue), and numbers
(green). Light Modern uses its corresponding accessible light-background palette.
No theme is switched and no global user color overrides are written.

## Built-in diagnostics

The extension checks IR as you type, without `llvm-as`. Every error below is one
`llvm-as` rejects; the test suite checks that against LLVM when it is installed, and
checks that clang output (with `-O0`–`-O3`, `-g` debug info, C++ exceptions, computed
`goto`, and atomics) produces no errors or warnings.

| Severity | Code | Reports |
| --- | --- | --- |
| Error | `undefined-value`, `undefined-label`, `undefined-type`, `undefined-metadata` | Names with no definition, with a “Did you mean …?” quick fix |
| Error | `duplicate-definition` | Redefinitions of a global, type, metadata node, or local name (values, parameters, and blocks share one namespace per function) |
| Error | `numbering` | Numbered values that do not increase, counting unnamed parameters, blocks, and results |
| Error | `missing-terminator`, `empty-body`, `missing-body`, `unclosed-body` | Blocks without `ret`/`br`/…, and malformed function bodies |
| Error | `entry-branch`, `not-a-label`, `phi-position`, `phi-predecessors` | Branches to the entry block or to values, and `phi` placement or incoming blocks that do not match the predecessors |
| Error | `dominance` | Uses of a value on a path where it is not yet defined, and non-`phi` self references |
| Error | `type-mismatch`, `return-type`, `void-result`, `memory-operands` | Operands whose known type differs from the one written, wrong `ret`, naming a `void` result, and `store`/`load` operands in the wrong order |
| Error | `unknown-instruction` | Misspelled opcodes, with a quick fix |
| Warning | `call-signature`, `variadic-call` | Calls whose arguments or result differ from the callee's declaration, and variadic calls without the function type that LangRef requires (quick fix inserts it) |
| Warning | `division-by-zero`, `unreachable-code`, `undefined-attributes` | Constant zero divisors, instructions after a terminator, and attribute groups LLVM would silently drop |
| Hint (faded) | `unused-value`, `unused-declaration`, `unused-private`, `unreachable-block` | Values, declarations, and private symbols that are never used, and blocks no path reaches |

An undefined `@name` that another workspace file defines gets an **Add declaration**
quick fix, using the same agreed declaration as completion.

The checks stay silent when the parse cannot establish a fact: unknown types,
implicitly numbered branch targets, or unparsed instructions. `llvm-as` remains the
authority, and when it reports an error on a line, the built-in error on that line is
hidden so a mistake appears once. Set `llvmIR.diagnostics.scope` to `workspace` to
check every indexed file; **LLVM IR: Verify Workspace** runs `llvm-as` on all of them
and summarizes how many fail.

Run **LLVM IR: Verify Document** for immediate verification. Execution/availability
issues appear in the **LLVM IR Language Tools** Output channel. Verification requires
a trusted workspace. Source is passed through stdin with no shell, execution of IR,
or output files in your project. Missing LLVM does not disable other editing features.

## Scope and limitations

The analyzer tolerates incomplete source but is not a complete LLVM parser. It
infers common instruction types and uses `unknown` when a type cannot be established.
Opaque `ptr` values do not imply a known pointee type.
An access hint records how a pointer is used; it does not prove a source-language
class or a permanent pointee type. Conflicting uses or an escaping stack slot
prevent the corresponding hint. Value and receiver hints come
from direct stores and constant tables in the current file only; memory written by
`memcpy`, through an escaped pointer, or by another module is not observed. Any
non-global value stored to the same field withholds the hint.
Operand completion computes dominance from `br`/`switch`/`invoke` labels in the
current function. It filters by the inferred type, so values of `unknown` type are
still offered, ranked below exact matches. It suggests values, not constant
expressions.

Navigation/completion use the configured workspace index, not a linker or a complete
LLVM language server. Signature help requires a local function declaration/definition. Numbered
identifiers cannot be renamed because their numbering is structural. Unusual or
new target-specific constructs may have limited editor analysis even when LLVM
accepts them. Compiler diagnostics reflect the configured LLVM version.

Formatting changes indentation and trailing whitespace, not instruction layout or
semantics. There is no debugger, automatic refactoring, or diagnostic quick-fix
engine. This is a local package, not a published Marketplace release.

## Develop and test

Source/tests require Node.js 18 or later; packaging tools require Node.js 20 or later.
Open the repository in VS Code and press **F5** for an Extension Development Host.

```sh
npm test
npm run test:integration
npm run package
```

The integration runner normally downloads a test VS Code. To use an existing
Linux installation:

```sh
VSCODE_EXECUTABLE_PATH=/usr/share/code/code npm run test:integration
```

Tests use temporary user/extension directories and do not install into your daily
profile. Linux needs a display (or `xvfb-run`). Unit tests need no VS Code. Real
LLVM tests skip when `llvm-as` is unavailable. A few tests also run against course
homework that is not part of this repository; they skip unless `LLVM_IR_COURSE_DIR`
points at a directory containing `hw0/` and `hw2/`. Set it in the environment or copy
`.env.example` to `.env` (gitignored).
The host tests also tokenize against the actual bundled Dark Modern and Light
Modern themes, asserting six distinct role colors and matching label references.
Multi-root tests use copied temporary fixtures to check unopened-file navigation,
cross-file references/rename, collisions, exclusions, library hovers and dirty buffers.

## Attribution and references

The original grammar/editor configuration are from Leo Pagano's MIT-licensed LLVM
IR Highlighter. This fork includes the MIT license in `LICENSE.md` and adds
language analysis and editor services.

- [LLVM Language Reference](https://llvm.org/docs/LangRef.html)
- [VS Code programmatic language features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
- [VS Code syntax highlighting guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)
