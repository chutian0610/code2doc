---
name: code2doc-operator
description: Maintain a living, symbol-anchored doc tree for a codebase with the code2doc CLI — init, write anchored pages, distill how-tos from user questions, and keep status green. Use when asked to document a repo, update its docs after code changes, or answer recurring codebase questions durably.
---

# Operating code2doc

You are the **Operator**: the AI code agent that writes and maintains
the docs. code2doc is model-free — it never writes a line of prose. It
indexes the code's symbols and verifies the **anchors** you leave on
factual claims. When the code moves, `status` names exactly which claims
broke, drifted or were never written. Your job is to keep that report
green; the tool's job is to make staleness impossible to miss.

The CLI is `code2doc` (run via `npx @chutian0610/code2doc` when not
installed). Two commands, nothing else: `init` and `status`.

## Vocabulary

- **Page** — one markdown file of the doc tree, typed in the manifest:
  `overview` (architecture), `module` (one module's public surface),
  `flow` (one execution path), `howto` (a page distilled from a user question),
  `reference` (tables). Pages are few and judgment-driven — never an
  auto-generated mirror of the code tree.
- **Anchor** — a plain markdown link whose title carries a symbol's
  **fingerprint**: `[greet](../src/greet.ts "c2d:src/greet.ts#greet:<sig>.<body>")`.
  The URL stays clickable for Readers; the tool reads only the title.
- **Fingerprint** — two truncated hashes over the symbol's signature
  and body. Lookup is by file + name, so line shifts never break
  anchors.
- **Signals** — `Broken` (symbol gone or signature changed: rewrite the
  claim), `Drift` (body changed: review the claim), `Missing` (a public
  symbol of a module with no anchor on its module page: document it).
  Doc-to-doc links are checked for target existence; a missing target
  is Broken.

## Workflow

### 1. Init

```
code2doc init
```

Writes config (`code2doc.config.json` — include/exclude globs, doc root,
doc language), an empty manifest, a doc-tree skeleton, and prints a JSON
report: the discovered modules and **every public symbol with its
fingerprint**. Write docs in the configured language (default English).
Re-running init is safe: config and skeleton files are only written
when missing, and existing manifest content is preserved.

### 2. Plan the manifest

Edit `<docRoot>/manifest.json` — a page exists when the manifest
declares it:

- one `overview` page for the repo;
- one `module` page per source directory you commit to covering, with
  `"module": "src/that/dir"` — every public symbol there must get an
  anchor (Missing is enforced);
- `flow` pages for execution paths worth explaining — your judgment,
  no coverage pressure;
- `howto` pages as user questions get distilled (below).

Only declare pages you will actually write. A skeleton first: manifest
entries, then the files.

### 3. Write anchored pages

Copy fingerprints from the init report's `symbols` array (re-run `init`
any time to refresh it). Anchor every factual claim about specific code;
prose with no code-level claim needs no anchor. On **module** pages,
anchor every public symbol of the mapped directory — the bullets ARE the
page. Link pages to each other with ordinary relative links; renames
will surface as Broken links.

### 4. Check

```
code2doc status          # human table + drill-down
code2doc status --json   # machine-readable, your entry point
```

Exit codes: `0` all accurate, `1` Drift-only, `2` any Broken or Missing.
Iterate until `status` exits 0 with zero signals, then commit docs,
manifest and config alongside the code (the `.code2doc/` cache is
derived state, ignored and rebuildable).

### 5. Maintain after code changes

Run `status` before finishing any task that touched code:

- **Broken** — the claim is likely wrong. Rewrite it against the new
  code, then update the anchor's fingerprint (re-run `init` for the new
  hash). Never paste a new fingerprint over an unrewritten claim.
- **Drift** — the symbol's body changed. Check whether the claim still
  holds: if yes, refresh the fingerprint; if no, rewrite first.
- **Missing** — a new public symbol with no anchor on its module page.
  Document it, or consciously re-scope (a module page's mapping is a
  promise).
- Also respond to new pages the code demands: a new core path may
  deserve a `flow` page; a removed module means its page and manifest
  entry go too.

### 6. Distill How-to pages from user questions

When the user asks a question about the codebase and you answer it,
that answer is documentation candidate #1: it will be asked again.
Distill it:

1. add `{ "path": "howtos/<slug>.md", "type": "howto" }` to the manifest;
2. write the page: the user's question as the title, your answer as
   anchored prose — same rules, every factual claim carries a
   fingerprint;
3. link it from related pages so Readers (human and agent) find it;
4. `status` green, commit.

A how-to ages under the same rules as everything else — when the code
it describes moves, the page says so loudly. That is the point.

## Rules of thumb

- Few, precise pages beat a generated mirror nobody trusts.
- Anchor claims, not decoration: a link whose text says nothing
  verifiable is noise.
- The manifest is the contract; the doc tree below it is fulfillment.
- Readers first: an agent loads the manifest + `status --json` to
  decide which pages to read; keep both honest.
