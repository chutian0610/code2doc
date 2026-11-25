<!-- A snapshot transcript: every output below was really produced by
     running @chutian0610/code2doc at its current version against a
     small TS+Python repo. Fingerprints and counts will drift; the
     sequence of actions is what you should imitate. -->

# Operator transcript: a mixed TS+Python repo, end to end

Follow this as the canonical action sequence. The repo is
`polyglot-cli`: a TypeScript entry that drives a Python parser — five
files, two languages, no `node_modules`. Every step shows the command
run and the (excerpted) real output.

## 1. Index the repo

```
$ code2doc init
```

The report is JSON. The parts you act on:

```json
{
  "filesScanned": 5,
  "modules": [
    { "dir": "parser", "files": 2, "publicSymbols": ["MAX_FIELDS", "parse", "validate", "is_importable"], "internalCount": 0 },
    { "dir": "src",    "files": 3, "publicSymbols": ["run", "countDeps", "summarize"], "internalCount": 0 }
  ],
  "symbols": [ { "name": "run", "file": "src/index.ts", "fingerprint": { "signature": "…", "body": "…" } }, … ]
}
```

One `init` indexed both languages — the default include derives from
the registry, so `.ts` and `.py` landed without touching config. The
`symbols` array carries every public symbol with its fingerprint: that
is what anchors are made from.

## 2. Plan the manifest

Two modules, two module pages, one overview:

```json
{ "pages": [
  { "path": "overview.md", "type": "overview" },
  { "path": "modules/cli.md", "type": "module", "module": "src" },
  { "path": "modules/parser.md", "type": "module", "module": "parser" }
] }
```

## 3. Write anchored pages

Each anchor copies a fingerprint from the report into a link title.
The overview anchors the two entry symbols; each module page anchors
its directory's whole public surface:

```markdown
# polyglot-cli

A TypeScript [runner](../src/index.ts "c2d:src/index.ts#run:<sig>.<body>") drives a Python [parser](../parser/parse.py "c2d:parser/parse.py#parse:<sig>.<body>").

# src

[run](../src/index.ts "c2d:src/index.ts#run:<sig>.<body>") drives the pipeline.
[countDeps](../src/report.ts "c2d:src/report.ts#countDeps:<sig>.<body>") totals dependencies per entry.
[summarize](../src/summary.ts "c2d:src/summary.ts#summarize:<sig>.<body>") renders the line.

# parser

[MAX_FIELDS](../parser/parse.py "c2d:parser/parse.py#MAX_FIELDS:<sig>.<body>") caps split fields per line.
[parse](../parser/parse.py "c2d:parser/parse.py#parse:<sig>.<body>") splits one raw line.
[validate](../parser/parse.py "c2d:parser/parse.py#validate:<sig>.<body>") rejects empty fields.
[is_importable](../parser/rules.py "c2d:parser/rules.py#is_importable:<sig>.<body>") gates downstream use.
```

The URL stays a clickable relative link; the tool reads only the
title.

## 4. Verify

```
$ code2doc status --json
{"broken": 0, "drift": 0, "ripple": 0, "missing": 0}   # exit 0
```

Commit docs, manifest and config with the code (`.code2doc/` is
derived state, git-ignored).

## 5. Code changes: answer the signals

A teammate rewrites the body of `countDeps` in `src/report.ts` (the
per-entry arithmetic changed). Before finishing the change:

```
$ code2doc status --json   # exit 1
{"broken": 0, "drift": 1, "ripple": 1, "missing": 0}
```

Page states tell the tier: `modules/cli.md` carries the drifted anchor;
`overview.md` flips to `ripple` — its anchor on `run` is untouched, but
`run` calls the stale `countDeps` two hops away.

The drill-down says exactly what moved and what it reached:

```json
// src/report.ts#countDeps → drift — body changed
// src/summary.ts#summarize → ripple — callee went stale
//     [{ "symbol": "src/report.ts#countDeps", "state": "drift", "via": "src/report.ts#countDeps", "depth": 1 }]
// src/index.ts#run → ripple — callee went stale
//     [{ "symbol": "src/report.ts#countDeps", "state": "drift", "via": "src/summary.ts#summarize", "depth": 2 }]
```

The agent reads the diff, checks the two claims about `summarize` and
`run` (both still accurate — they describe what the functions do, not
how the total is computed), and re-signs the reviewed drift:

```
$ code2doc refresh
modules/cli.md: 1 anchor(s) refreshed
$ code2doc status --json
{"broken": 0, "drift": 0, "ripple": 0, "missing": 0}   # exit 0
```

Rules the sequence above exercises: Drift is reviewed then refreshed
(`refresh` refuses signature changes and vanished symbols — those are
rewrites); Ripple is review-only, most ripples end refreshing nothing;
`run` reached its stale callee through two hops and the drill-down
names the path (`via`, `depth`).

## 6. Distill a question

The user asks *"why does the parser cap fields at 8?"* The answer
becomes a page: manifest entry
`{ "path": "howtos/max-fields.md", "type": "howto" }`, then the page —
question as title, answer as anchored prose:

```markdown
# Why does the parser cap fields at 8?

The raw entry format guarantees at most eight `|`-separated fields per
line. [MAX_FIELDS](../parser/parse.py "c2d:parser/parse.py#MAX_FIELDS:<sig>.<body>") is the enforcement point:
[parse](../parser/parse.py "c2d:parser/parse.py#parse:<sig>.<body>") slices the split result to that bound…
```

`status` green, commit. The next session loads this answer verified
instead of re-deriving it.

## Appendix: CI gate

One step keeps the tree honest in CI — a repo that forgets `status`
gets a red build, not silent rot:

```yaml
- name: doc-tree freshness
  run: npx @chutian0610/code2doc status
```

Exit code `1` (Drift/Ripple — review recommended) fails the step; pass
`--fail-on broken,missing` to fail only on hard signals if the team
prefers review-tier noise to stay out of CI.

---

*Snapshot disclaimer applies: fingerprints, counts and the example
names are real as of the recorded run. The human-facing walkthrough of
the same workflow lives in the code2doc repo at
`examples/guice-story.md`.*
