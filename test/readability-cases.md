# Popup readability acceptance cases

- Label: one label header; 1-based definition line and owning function, including references, quoted/numeric names, CRLF, and edits that move the definition.
- Parameter: one typed name, owning function and location; no repeated definition/type block.
- SSA result: one source statement and inferred result type/location; unsupported types explicitly not inferred.
- Global/type/metadata/attribute group: one definition and location; no fabricated or inapplicable unknown type.
- Function: preserve the concise single signature and ABI attributes introduced in 1.1.3.
- Completion: useful type/location details; no label:label, attribute:unknown, or duplicate function signature documentation.
- Signature help: signature only in its primary slot; documentation supplies location.
- Outline: retain useful variable/function types, omit label/metadata/attribute filler and unknown placeholders.
- Long previews: at most 10 source lines and 1000 UTF-16 code units, explicit truncation notice; never split a surrogate pair.
- Source-derived Markdown stays untrusted and uses escaped text/code blocks. Existing docs/comparison tables remain intact.
