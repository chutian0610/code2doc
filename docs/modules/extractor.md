# Extractor module (`src/extractor/`)

One language = one extractor behind a shared contract; the core never
branches on language. Every public export of `src/extractor/` is
anchored here (the **Missing** guarantee for this module).

## `types.ts` — the contract

[Extractor](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Extractor:bf2a6a2b466f5022.bf2a6a2b466f5022") is the whole interface:
a language id, claimed file extensions, and one `extract` returning
[SymbolRecord](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolRecord:559164f730143ba9.559164f730143ba9")s. A record's stable
identity is `<file>#<name>@<signature start row>`; its
[Fingerprint](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Fingerprint:0ea1cb3c50e1c4a4.0ea1cb3c50e1c4a4") is the pair of
hashes anchors carry — signature and body — truncated to
[FINGERPRINT_HEX](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FINGERPRINT_HEX:743557745bb3de75.1574bddb75c78a6f") hex chars
each. [Visibility](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Visibility:75e723b0d2e1b720.75e723b0d2e1b720") decides what
counts for the Missing signal.

- [SymbolKind](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolKind:f5d0046356a20352.f5d0046356a20352") — function / class / interface / type / enum / variable
- [Span](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Span:3178c8297160d652.3178c8297160d652") — a source region: UTF-8 byte offsets plus start row/col

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

[createTsExtractor](../../src/extractor/ts.ts "c2d:src/extractor/ts.ts#createTsExtractor:897c7bab7910f380.6351426a2485d117") covers the
TS family on web-tree-sitter with the official grammar (`.tsx`/`.jsx`
use the tsx grammar, everything else typescript-as-superset). Top-level
declarations are the symbols; `export` means public.

[createJavaExtractor](../../src/extractor/java.ts "c2d:src/extractor/java.ts#createJavaExtractor:2686da3769936336.ca5c27ff4b6f2af5")
mirrors it on tree-sitter-java: top-level types plus their direct
methods (constructors excluded — their name is the class's and would
collide in `file#name` lookup); only `public` is public, with interface
members implicitly public per the language rule.

Back to the [overview](../overview.md).
