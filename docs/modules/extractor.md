# Extractor module (`src/extractor/`)

One language = one extractor behind a shared contract; the core never
branches on language. Every public export of `src/extractor/` is
anchored here (the **Missing** guarantee for this module).

## `types.ts` — the contract

[Extractor](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Extractor:6aef985d5b65e524.6aef985d5b65e524") is the whole interface:
a language id, claimed file extensions, `extract` returning
[SymbolRecord](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolRecord:2a1b18c8ccab6ec3.2a1b18c8ccab6ec3")s, and an
optional `extractRefs` returning
[FileRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FileRefs:ebb8c0be16b6765e.ebb8c0be16b6765e") and optional
`resolveImport` (ADR-0005) resolving one
[ImportBinding](../../src/extractor/types.ts "c2d:src/extractor/types.ts#ImportBinding:1ae251464b109af4.1ae251464b109af4") — named or
default — against the [ImportIndex](../../src/extractor/types.ts "c2d:src/extractor/types.ts#ImportIndex:49ef9a843e77962b.49ef9a843e77962b")
probe the core hands in. Both v2 languages implement both; a language
without them produces no edges and no Ripple. A record's stable
identity is `<file>#<name>@<signature start row>`; its
[Fingerprint](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Fingerprint:0ea1cb3c50e1c4a4.0ea1cb3c50e1c4a4") is the pair of
hashes anchors carry — signature and body — truncated to
[FINGERPRINT_HEX](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FINGERPRINT_HEX:743557745bb3de75.1574bddb75c78a6f") hex chars
each. [Visibility](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Visibility:75e723b0d2e1b720.75e723b0d2e1b720") decides what
counts for the Missing signal.

- [SymbolKind](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolKind:f5d0046356a20352.f5d0046356a20352") — function / class / interface / type / enum / variable
- [Span](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Span:3178c8297160d652.3178c8297160d652") — a source region: UTF-8 byte offsets plus start row/col
- [symbolId](../../src/extractor/types.ts "c2d:src/extractor/types.ts#symbolId:b902b4b28cb17fa1.1749aebf78122b5b") / [parseSymbolId](../../src/extractor/types.ts "c2d:src/extractor/types.ts#parseSymbolId:a68cd8727243f2a2.6044fc45ac81749b") — the one spelling of a symbol's `file#name` identity key, used by anchors, edges and reports
- [FileRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FileRefs:ebb8c0be16b6765e.ebb8c0be16b6765e") — a file's call refs: import bindings plus caller → called names (ADR-0004)
- [noRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#noRefs:4f6939c927a01702.f7254f11f97b32f9") — the empty ref table
- [collapseCallers](../../src/extractor/types.ts "c2d:src/extractor/types.ts#collapseCallers:1c6a0f88f359f57c.66c97580a9e7c239") — shared, deterministic caller-map normalization, also the baseline for languages without edge extraction

## `fingerprint.ts` — the parity machinery

Two extractors hashing the same text the same way make anchor
verification language-blind. [fingerprintOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#fingerprintOf:e4530e3ecd77d069.6dc6a76977da76ed")
builds each hash input by cutting [CommentRange](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#CommentRange:43459109b54c06be.43459109b54c06be")s
at AST granularity (a regex would misfire on `//` inside strings) and
collapsing whitespace runs — comment-only and reflow edits stay fresh,
real changes never hide. [spanOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#spanOf:395ac4b77fd8ecf2.8637e31997a480ba")
converts a tree-sitter node to a [Span](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Span:3178c8297160d652.3178c8297160d652").

## `registry.ts` — dispatch by extension

[extractorForFile](../../src/extractor/registry.ts "c2d:src/extractor/registry.ts#extractorForFile:205bcbf1cfc8f4e1.f9cda4200ff97c92") maps a
file to its extractor by extension. The registry holds one shared,
stateless instance per language; adding a language is appending one
entry — see the [howto](../howtos/add-a-language.md).

## `ts.ts` and `java.ts` — the v1 languages

[createTsExtractor](../../src/extractor/ts.ts "c2d:src/extractor/ts.ts#createTsExtractor:7a398749a8408b2d.6d1a4526b9195050") covers the
TS family on web-tree-sitter with the official grammar (`.tsx`/`.jsx`
use the tsx grammar, everything else typescript-as-superset). Top-level
declarations are the symbols; `export` means public. Its `extractRefs`
captures call/member-call by final identifier, `new` and
`extends`/`implements`, attributing each site to its enclosing top-level
function or variable (heritage to the class); function-as-value
references are a documented blind spot.

[createJavaExtractor](../../src/extractor/java.ts "c2d:src/extractor/java.ts#createJavaExtractor:587eb227fb05f69b.db90e30fd7a9ccc7")
mirrors it on tree-sitter-java: top-level types plus their direct
methods (constructors excluded — their name is the class's and would
collide in `file#name` lookup); only `public` is public, with interface
members implicitly public per the language rule. Its `extractRefs`
captures any method invocation by its name field, construction and
heritage, attributing calls to the enclosing top-level method (methods
are symbols here) and heritage to the class; imports normalize to
package-path form (`demo/other/Base.java`), with wildcards claiming no
name. Its `resolveImport` matches a package path against indexed files
by unique suffix — whatever the package root — so external libraries
resolve nothing.

Back to the [overview](../overview.md).
