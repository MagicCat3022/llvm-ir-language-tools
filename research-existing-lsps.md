# Existing LLVM IR LSPs: implementation research

Static source review on 2026-09-10; upstream code and dependency installation were not executed. This is a focused integration assessment, not a claim that every upstream feature is exhaustively tested.

## Conclusion

Existing LLVM IR servers are worth learning from, but the two examined implementations do not provide the requested combination of safe cross-file editing and C-library/intrinsic help. Keep the current extension's parser/providers for this increment and add an original workspace identity/index layer and documentation catalog. The source findings below motivate that choice; they are not a general recommendation against those projects for their intended uses.

## indoorvivants/llvm-ir-lsp

Reviewed commit `313a67b39c64b6d740d4e9041ffd3d34ce4edf93`.

The project explicitly targets **read-only** LLVM navigation. It has workspace function search and cross-file call navigation, but its didOpen/didSave handlers read disk and there is no didChange handler. It is therefore not a drop-in editing backend. [Source: README](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/README.md#L11-L20), [event handlers](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/src/main/scala/lsp.scala#L330-L342).

Its workspace identity is a raw function name: a local declaration prevents the cross-file implementation fallback, duplicate names resolve to the first matching definition, and references merge same-name calls across all files. The indexed function record does not preserve linkage. These are exactly the kinds of edge cases our implementation must handle conservatively. [Source: resolution](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/src/main/scala/Utils.scala#L255-L351), [index model](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/src/main/scala/Index.scala#L3-L23).

Its Scala Native toolchain and external executable/Langoustine setup would introduce a separate runtime integration. Build metadata declares Apache-2.0. [Source: build](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/build.sbt#L4-L51), [installation](https://github.com/indoorvivants/llvm-ir-lsp/blob/313a67b39c64b6d740d4e9041ffd3d34ce4edf93/README.md#L25-L73).

## r4ai/llvm-analyzer

Reviewed commit `8db7866a0e0c73584017ee67bf78d421bdbadaab`.

This is a much broader editor implementation with pure parser/analyzer packages, an LSP adapter, and a VS Code extension. However, **workspace symbols and call hierarchy are not cross-file definitions/references/rename/completion**: those four providers receive a single snapshot and emit locations/edits for that snapshot's URI. [Source: architecture](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/docs/architecture.md#L8-L37), [local navigation](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/lsp/features.ts#L317-L346), [completion/rename](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/lsp/features.ts#L389-L425).

Useful patterns to adapt: URI-based replacement, dirty-buffer precedence over disk, restore-on-close, immutable versioned snapshots, bounded workspace indexing concurrency, and deferred derived indexes that keep local hover/navigation responsive. [Source: workspace index](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/lsp/workspace-symbols.ts#L37-L150), [snapshot/indexing flow](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/server.ts#L363-L438).

Important static-review risks not to copy:

- Cross-file call hierarchy resolves by raw name and chooses the first function, without linkage or definition-versus-declaration discrimination. [Source](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/lsp/call-hierarchy.ts#L56-L105).
- Disk reads check for an open document before an `await` but publish afterward without checking again; a buffer can open/reopen while that read is pending. Use per-URI lifecycle generations and recheck after asynchronous reads. [Source](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/language-server/src/server.ts#L441-L467).
- Its built-in doc catalogs cover instructions, attributes, and types—not libc behavior or an intrinsic-family catalog. Semantic diagnostic codes cover four structural/name issues, not format-string validation. [Source: catalogs](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/analyzer/src/semantic/docs.ts#L1-L12), [diagnostics](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/analyzer/src/semantic/types.ts#L115-L135).

The project is MIT licensed. Its source is private TypeScript workspace packages, but its build creates CommonJS extension/server bundles, so adaptation is technically possible; it is not a published zero-dependency CommonJS module. Node>=24 is the development requirement. [Source: license](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/LICENSE), [root manifest](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/package.json#L22-L32), [bundles](https://github.com/r4ai/llvm-analyzer/blob/8db7866a0e0c73584017ee67bf78d421bdbadaab/packages/vscode-extension/esbuild.mjs#L5-L24).

## Official LLVM effort

GitHub's API reports that [LLVM PR #161969](https://github.com/llvm/llvm-project/pull/161969), introducing `llvm-lsp-server`, is still **open and unmerged** on 2026-09-10 (`merged:false`, `merged_at:null`; head `7735aa909deb1d6bc9f1594013eb5c4c69cad6d9`). The proposal body lists open/close sync, references, and document symbols. It should not be presented as an already-shipped complete editor backend. [API source](https://api.github.com/repos/llvm/llvm-project/pulls/161969).

## Regression cases this review adds to our checklist

- A local declaration must still allow navigation to an unambiguous compatible external definition.
- Same-name local-linkage functions in different modules must remain distinct.
- Multiple definitions must be surfaced as ambiguity, not resolved by directory iteration order.
- Unsaved edits must override disk, including changes during asynchronous indexing; close/reopen/delete/create events must not restore stale snapshots.
- Workspace symbol search may show module-local names without granting them cross-file rename identity.
- `.llvm` discovery, workspace-folder scope, URI escaping, and incomplete-index limits require deliberate handling rather than assuming another server's `.ll` filesystem scan is sufficient.
- Library/intrinsic documentation and format checking need their own evidence-based implementation; neither investigated project's feature list proves they exist.

These are implementation recommendations inferred from the linked source limitations above, not claims of exhaustive LLVM language coverage.

## Design adopted in this extension

[clangd's index design](https://clangd.llvm.org/design/indexing) separates live-file
symbols from background project information. We apply the same principle with
per-URI immutable snapshots: current buffers override disk; lifecycle and scan
generations invalidate late reads. Unlike clangd, our source analyzer does not
provide a compiler-derived symbol identity or compilation/link database, so
cross-file identity is deliberately more conservative and project scope is explicit.

[LLVM linkage rules](https://llvm.org/docs/LangRef.html#linkage-types) motivate
module-local private/internal/numeric names, external declaration-to-definition
navigation and weak/ODR ambiguity refusal. Visibility and dso_local do not make
a symbol module-private. Quoted identifiers compare by bytes, retaining the
leading no-mangling marker rather than guessing platform names.

[LLVM data layout](https://llvm.org/docs/LangRef.html#data-layout) also supplies
default program/global address spaces through P/G components. Regression tests
cover implicit versus explicit address spaces and missing/mismatched module
targets/layouts. Unknown ABI comparisons, named types, attribute groups, COMDAT,
aliases/ifunc identities, assembly, linker options and debug linkage strings are
reasons to refuse rename rather than claim linker-complete refactoring.

Before returning edits, the adapter re-reads closed affected files and checks open
versions, whole-index snapshot identities, membership and lifecycle generations
after asynchronous operations. This guards observed stale-index races, but the
VS Code provider API does not lock external writers. Excluded files, linker scripts,
dynamic lookup strings, binary dependencies and downstream consumers remain outside
the configured index; previewing edits is still required.

The implementation remains native VS Code providers, not an LSP protocol server.
No upstream server code or new runtime dependency was incorporated. The research
changed the identity model, overlay lifecycle, refusal rules and regression suite;
the existing local readability/highlighting providers remain in place.
