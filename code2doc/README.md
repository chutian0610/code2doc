# Documentation

This doc tree is driven by `manifest.json` — a page exists when the
manifest declares it, not because a file happens to live here.

Each page has a type that decides how it is checked:

- **overview** — architecture and domain, static structure
- **module** — a module's responsibilities and public interface (coverage enforced)
- **flow** — a core execution path or piece of critical logic
- **howto** — a task guide distilled from a user question
- **reference** — tabular reference material

## Anchors

Factual claims link to the code they describe; the link title carries the
symbol's fingerprint (from the `symbols` array `code2doc init` prints):

`[greet](../src/greet.ts "c2d:src/greet.ts#greet:<signature>.<body>")`

The URL stays a normal, clickable markdown link for Readers.
`code2doc status` reads the title and verifies the fingerprint against the
current code: signature changed or symbol gone → **broken**; body changed →
**drift**; still matching → fresh.

**module** pages also declare the source directory they document
(`"module": "src"`); a public export of that module with no anchor on the
page is reported as **missing** — internal symbols never count.

Ordinary links between pages are checked too: a doc-to-doc link whose
target file is missing is reported as broken. Files in this tree that the
manifest does not declare are ignored.

Run `code2doc status` to see the freshness of every declared page.

## This repo's tree

code2doc documents itself — the dogfood tree:

- [overview](overview.md) — what the tool is, its shape
- [core module](modules/core.md) · [commands](modules/commands.md) ·
  [extractor](modules/extractor.md) — the public surface, per module
- [the status check](flows/status-check.md) — one verification pass, step by step
- [add a language extractor](howtos/add-a-language.md) — a distilled how-to

The [manifest](manifest.json) declares the pages; architecture decisions
live in [adr/](adr/).
