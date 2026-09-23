# Architecture

## 1.2.0 modules and boundaries

- src/symbol-names.js: shared byte-aware LLVM identity helpers; root-owned.
- src/workspace-index.js: pure index, linkage/compatibility filtering, targets and safe rename plans; index agent-owned.
- src/library.js: offline source-linked libc/intrinsic catalog; library agent-owned.
- src/workspace.js: VS Code discovery, dirty-overlay lifecycle, generations and exclusions/limits; adapter agent-owned; concrete index is injected.
- src/workspace-providers.js: root-owned async provider integration, snapshot-to-URI/range mapping, library rendering and rename freshness gate.
- src/extension.js: root registers workspace lifecycle/providers and preserves the synchronous local provider factory for focused tests.
- Exact index/catalog contracts: src/workspace-contracts.js plus existing src/contracts.js. Independent pure modules are certified before adapter integration.
- Research: repo-reader maps existing servers; root records design choices, tested edge cases, and unresolved limits.

Workspace roots isolate projects by default. Optional projectRoots partition subprojects. An index does not prove linker membership or runtime symbol binding: navigation can present multiple candidates and rename must reject uncertain/partial cases.

Readability refinement: grammar agent owns TextMate grammar and tokenizer tests; provider agent owns semantic-label handling and basic-block folds plus provider tests; knowledge agent owns placeholder syntax and comparison tables plus knowledge tests. Shared knowledge entries gain optional curated Markdown details. Root owns details rendering, semantic token manifest mappings, release metadata, docs, and integration acceptance. Existing analysis contracts and semantic token index 4 (label) remain unchanged. All three changes are independently unit-testable; integrate only after those checks.

Three independent modules: src/analysis.js (text, tokens, symbols and types), src/knowledge.js (instruction/keyword documentation), src/diagnostics.js (LLVM subprocess validation). src/extension.js adapts these to VS Code with caching and lifecycle handling. All pure modules use the exact src/contracts.js documented shapes. Build and certify independent modules before integration. Tests use node --test test/*.test.js, followed by a real VS Code extension-host smoke test and VSIX package inspection.

Ownership: analysis agent owns analysis + analysis tests; knowledge agent owns knowledge + knowledge tests; diagnostics agent owns diagnostics + diagnostics tests. Integration agent later owns extension.js and provider tests; root owns contracts, manifest, packaging, integration acceptance and docs. Offsets are UTF-16 indices with exclusive ends throughout.
