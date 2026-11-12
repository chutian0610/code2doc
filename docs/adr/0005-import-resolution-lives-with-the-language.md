# Import resolution lives with the language

ADR-0001 promises the core never branches on language, but by the end of v2 the promise had a quiet exception: `resolveEdges` resolved import claims in the core by branching on the *form* of the binding's source string — a `'./'` prefix meant relative-path resolution with a copied extensions list, a `.java` suffix meant package-path matching. Two languages made two branches; the third would have made three, plus another copy of the extensions list to keep in sync.

The mechanism now (agreed in the post-v2 architecture review): each `Extractor` exposes an optional `resolveImport(file, binding, index)`. The language constructs its own candidate paths and knows its own specifier forms; the core hands it an `ImportIndex` probe — lookup by path, suffix enumeration for package forms — and nothing else. `resolveEdges` dispatches claims to the file's extractor and treats every unresolved claim the same: no edge, no fall-through (the never-false rule of ADR-0004 is unchanged). Import bindings are a tagged union: `{ kind: 'named' | 'default' }` — the old `imported: ''` sentinel for default imports is data now, and a default binding claims its name while never resolving.

## Consequences

- Adding a language means writing its resolution next to its grammar, with tests at the extractor seam — the "config plus tests" promise of v1 applies to call edges too.
- The cache's refs shape changed with the tag (`version: 4`); foreign-version caches rebuild per the ADR-0003 guard.
- A language without `resolveImport` behaves as if every import claim is unresolved: names never fall through to same-file or global guesses.
