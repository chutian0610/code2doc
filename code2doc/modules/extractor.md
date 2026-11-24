# Extractor module (`src/extractor/`)

One language = one extractor behind a shared contract; the core never
branches on language. Every public export of `src/extractor/` is
anchored here (the **Missing** guarantee for this module).

## `types.ts` — the contract

[Extractor](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Extractor:a32f1f281dc2d9bc.a32f1f281dc2d9bc") is the whole interface:
a language id, claimed file extensions, `extract` returning
[SymbolRecord](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolRecord:4f5ed6548ed7782a.4f5ed6548ed7782a")s, and an
optional `extractRefs` returning
[FileRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FileRefs:cba8203c76dd5d9e.cba8203c76dd5d9e") and optional
`resolveImport` (ADR-0005) resolving one
[ImportBinding](../../src/extractor/types.ts "c2d:src/extractor/types.ts#ImportBinding:92bbcc8338ba4015.92bbcc8338ba4015") — named or
default — against the [ImportIndex](../../src/extractor/types.ts "c2d:src/extractor/types.ts#ImportIndex:ccc678625a5e3764.ccc678625a5e3764")
probe the core hands in. Both v2 languages implement both; a language
without them produces no edges and no Ripple. A record's stable
identity is its `file#name` key (the one spelling, [symbolId](../../src/extractor/types.ts "c2d:src/extractor/types.ts#symbolId:0d321a316e292098.6f901b9d5235b5c6") —
cache-local rows never break an anchor on line shifts); its
[Fingerprint](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Fingerprint:0ea1cb3c50e1c4a4.0ea1cb3c50e1c4a4") is the pair of
hashes anchors carry — signature and body — truncated to
[FINGERPRINT_HEX](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FINGERPRINT_HEX:743557745bb3de75.1574bddb75c78a6f") hex chars
each. [Visibility](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Visibility:75e723b0d2e1b720.75e723b0d2e1b720") decides what
counts for the Missing signal.

- [SymbolKind](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolKind:f5d0046356a20352.f5d0046356a20352") — function / class / interface / type / enum / variable
- [Span](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Span:3178c8297160d652.3178c8297160d652") — a source region: UTF-8 byte offsets plus start row/col
- [symbolId](../../src/extractor/types.ts "c2d:src/extractor/types.ts#symbolId:0d321a316e292098.6f901b9d5235b5c6") / [parseSymbolId](../../src/extractor/types.ts "c2d:src/extractor/types.ts#parseSymbolId:d55e55ad469d71fe.2e25447b3a6bf39e") — the one spelling of a symbol's `file#name` identity key, used by anchors, edges and reports
- [FileRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#FileRefs:cba8203c76dd5d9e.cba8203c76dd5d9e") — a file's call refs: import bindings plus caller → called names (ADR-0004)
- [noRefs](../../src/extractor/types.ts "c2d:src/extractor/types.ts#noRefs:90406e54aebd10fa.f0e9c13c08ddec65") — the empty ref table
- [collapseCallers](../../src/extractor/types.ts "c2d:src/extractor/types.ts#collapseCallers:87b6bbd2957e866c.e935194304b10e9e") — shared, deterministic caller-map normalization (Map in, prototype-less record out: caller names are arbitrary identifiers, and `toString`/`__proto__` must stay plain keys), also the baseline for languages without edge extraction
- [refCollector](../../src/extractor/types.ts "c2d:src/extractor/types.ts#refCollector:7af9d20572df3cca.d16684feeee3ed80") — the accumulator every extractor feeds (`note` during the walk, `finish` for the record); one home for the Map-in/prototype-less-out policy so adapters cannot drift on it again

## `fingerprint.ts` — the parity machinery

Two extractors hashing the same text the same way make anchor
verification language-blind. [fingerprintOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#fingerprintOf:e23fadfc0ac0d387.0aa63e736236223f")
builds each hash input by cutting [CommentRange](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#CommentRange:5495c57a5d55d259.5495c57a5d55d259")s
at AST granularity (a regex would misfire on `//` inside strings) and
collapsing whitespace runs — comment-only and reflow edits stay fresh,
real changes never hide. [spanOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#spanOf:999a07146b37a9e7.aa64b4be1098d0da")
[collectComments](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#collectComments:f449be6b93c12a65.f079062b817e55ce")
gathers those ranges from a tree — the loop lives next to the cutting so
collection cannot drift between adapters, while the query text stays with
each language (TS speaks `comment`, Java `line_comment`/`block_comment`).
converts a tree-sitter node to a [Span](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Span:3178c8297160d652.3178c8297160d652").

## `registry.ts` — dispatch by extension

[extractorForFile](../../src/extractor/registry.ts "c2d:src/extractor/registry.ts#extractorForFile:205bcbf1cfc8f4e1.f9cda4200ff97c92") maps a
file to its extractor by extension; [claimedExtensions](../../src/extractor/registry.ts "c2d:src/extractor/registry.ts#claimedExtensions:f7f712a28e5aa8f2.7cb98ae214793a06")
exposes what they claim — the one source the core's default include
derives from (#30), so a new language's files land in the index without
touching config. The registry holds one shared,
stateless instance per language; adding a language is appending one
entry — see the [howto](../howtos/add-a-language.md).

## `ts.ts` and `java.ts` — the v1 languages

[createTsExtractor](../../src/extractor/ts.ts "c2d:src/extractor/ts.ts#createTsExtractor:897c7bab7910f380.b44f82a71af16ccb") covers the
TS family on web-tree-sitter with the official grammar (`.tsx`/`.jsx`
use the tsx grammar, everything else typescript-as-superset). Top-level
declarations are the symbols — classes and abstract classes alike (a
distinct node type in the grammar, same class shape); `export` means
public. Its `extractRefs`
captures bare calls by name, `new` and
`extends`/`implements`, attributing each site to its enclosing top-level
function or variable (heritage to the class); function-as-value
references are a documented blind spot, and a member call is reported
only when its receiver chain bottoms out in a namespace import — then
as a named claim on that module's source (#26: methods are not symbols
here, and field-measured, every member-call name the global-uniqueness
step resolved was a false edge; Java, where methods are symbols, keeps
the old behavior). CommonJS `require`s become
claims like imports (#25): a destructured require yields named
bindings, a whole-module require a default one — the claimed name never
falls through, so requiring an external package that shares a name with
a repo symbol mints no false edge; relative sources resolve through the
same `resolveImport` machinery as ESM.

[createJavaExtractor](../../src/extractor/java.ts "c2d:src/extractor/java.ts#createJavaExtractor:794c96c564860aec.7519b6c000146bf7")
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

## `python.ts` — the third language

[createPythonExtractor](../../src/extractor/python.ts "c2d:src/extractor/python.ts#createPythonExtractor:d00c18b05bf88627.0458c0be0a08b22a")
mirrors the contract on tree-sitter-python: module-level `def`/`class`
targets plus UPPER_CASE assignments (the constants convention, kind:
variable) are the symbols — methods, nested defs, `if`-guarded blocks
and dunders never surface. Visibility follows the underscore convention
(leading underscore internal); `__all__`-driven visibility is a
documented blind spot. Decorators sit inside the signature span —
adding or removing one is an interface change — and only `#` line
comments are comments: a docstring is body, so editing one drifts a
claim instead of breaking it. A same-name redefinition is one record
per declaration, set-compared downstream under its name key (ADR-0006).
Its `extractRefs`/`resolveImport` pair is not written yet: until the
import-resolution work lands, Python files produce no call edges and no
Ripple — no edge beats a false edge (ADR-0004).

Back to the [overview](../overview.md).
