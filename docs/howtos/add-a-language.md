# How do I add a new language extractor?

*Distilled from a user question: "I want code2doc to index our Rust
code too — what does that take?"*

Adding a language is config and tests, not core surgery. The steps, in
order:

1. **Implement the contract.** One file in `src/extractor/`, exporting a
   factory returning an [Extractor](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Extractor:6aef985d5b65e524.6aef985d5b65e524"):
   a language id, the extensions it claims, and one `extract` that
   returns [SymbolRecord](../../src/extractor/types.ts "c2d:src/extractor/types.ts#SymbolRecord:2a1b18c8ccab6ec3.2a1b18c8ccab6ec3")s —
   name, kind, spans, [Visibility](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Visibility:75e723b0d2e1b720.75e723b0d2e1b720")
   and the [Fingerprint](../../src/extractor/types.ts "c2d:src/extractor/types.ts#Fingerprint:0ea1cb3c50e1c4a4.0ea1cb3c50e1c4a4") pair.

2. **Share the fingerprint machinery.** Do not hash by hand: run the
   declaration's spans through [fingerprintOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#fingerprintOf:e4530e3ecd77d069.6dc6a76977da76ed")
   with the file's comment ranges ([CommentRange](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#CommentRange:43459109b54c06be.43459109b54c06be"),
   [spanOf](../../src/extractor/fingerprint.ts "c2d:src/extractor/fingerprint.ts#spanOf:395ac4b77fd8ecf2.8637e31997a480ba") for the spans). Two
   extractors that hash the same text the same way are what makes anchor
   verification language-blind.

3. **Pin the language's rules** (mirror them from an existing
   extractor): which declarations are symbols (top-level only, and watch
   for name collisions in `file#name` lookup — that is why Java skips
   constructors), what public means in that language, and where the
   signature ends and the body begins. References:
   [createTsExtractor](../../src/extractor/ts.ts "c2d:src/extractor/ts.ts#createTsExtractor:7a398749a8408b2d.6d1a4526b9195050") and
   [createJavaExtractor](../../src/extractor/java.ts "c2d:src/extractor/java.ts#createJavaExtractor:587eb227fb05f69b.db90e30fd7a9ccc7").

4. **Register it.** Append the factory's instance to the registry list
   in `src/extractor/registry.ts`; dispatch is already extension-based
   via [extractorForFile](../../src/extractor/registry.ts "c2d:src/extractor/registry.ts#extractorForFile:205bcbf1cfc8f4e1.f9cda4200ff97c92").

5. **Test at the two seams.** Query-layer tests in `test/extractor/`
   pin extraction on snippets (name, signature span, body span,
   visibility — parity with the existing languages), and a fixture tree
   driven through the CLI seam shows the signals end to end.

6. **Re-run `code2doc init`** and update this doc tree: the extractor
   module page in `docs/modules/extractor.md` gains the new factory, or
   it will report Missing.

Back to the [overview](../overview.md).
