# How do I add a new language extractor?

*Distilled from a user question: "I want code2doc to index our Rust
code too — what does that take?"*

Adding a language is config and tests, not core surgery. The steps, in
order:

1. **Implement the contract.** One file in `src/extractor/`, exporting a
   factory returning an [Extractor](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Extractor:a32f1f281dc2d9bc.a32f1f281dc2d9bc"):
   a language id, the extensions it claims, and one `extract` that
   returns [SymbolRecord](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolRecord:4f5ed6548ed7782a.4f5ed6548ed7782a")s —
   name, kind, spans, [Visibility](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Visibility:75e723b0d2e1b720.75e723b0d2e1b720")
   and the [Fingerprint](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Fingerprint:0ea1cb3c50e1c4a4.0ea1cb3c50e1c4a4") pair.

2. **Share the fingerprint machinery.** Do not hash by hand: run the
   declaration's spans through [fingerprintOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#fingerprintOf:e23fadfc0ac0d387.0aa63e736236223f")
   with the file's comment ranges ([CommentRange](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#CommentRange:5495c57a5d55d259.5495c57a5d55d259"),
   [spanOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#spanOf:999a07146b37a9e7.aa64b4be1098d0da") for the spans). Two
   extractors that hash the same text the same way are what makes anchor
   verification language-blind.

3. **Pin the language's rules** (mirror them from an existing
   extractor): which declarations are symbols (top-level only, and watch
   for name collisions in `file#name` lookup — that is why Java skips
   constructors), what public means in that language, and where the
   signature ends and the body begins. References:
   [createTsExtractor](../../src/extractor/ts.ts "c2d:src/extractor/ts.ts#createTsExtractor:897c7bab7910f380.b44f82a71af16ccb"),
   [createJavaExtractor](../../src/extractor/java.ts "c2d:src/extractor/java.ts#createJavaExtractor:794c96c564860aec.7519b6c000146bf7") and
   [createPythonExtractor](../../src/extractor/python.ts "c2d:src/extractor/python.ts#createPythonExtractor:d00c18b05bf88627.0458c0be0a08b22a").

4. **Register it.** Append the factory's instance to the registry list
   in `src/extractor/registry.ts`; dispatch is already extension-based
   via [extractorForFile](../../src/extractor/registry.ts "c2d:src/extractor/registry.ts#extractorForFile:205bcbf1cfc8f4e1.f9cda4200ff97c92").

5. **Test at the two seams.** Query-layer tests in `test/extractor/`
   pin extraction on snippets (name, signature span, body span,
   visibility — parity with the existing languages), and a fixture tree
   driven through the CLI seam shows the signals end to end.

6. **Re-run `code2doc init`** and update this doc tree: the extractor
   module page in `code2doc/modules/extractor.md` gains the new factory, or
   it will report Missing.

Back to the [overview](../overview.md).
