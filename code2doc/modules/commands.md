# Commands module (`src/commands/`)

The Operator entrypoints behind `src/cli.ts`. Each is one `run`
function plus the JSON types it prints — the stdout contracts are the
tool's public interface. Their shared preamble lives in `common.ts`:
[currentCache](../../src/commands/common.ts "c2d:src/commands/common.ts#currentCache:8592307ecdaad9eb.6823ca7f28fa1a45")
brings the cache to current state — a missing config is a tool failure,
never a signal — and hands the command its config plus
[CurrentCache](../../src/commands/common.ts "c2d:src/commands/common.ts#CurrentCache:1a3c768b3f1a2037.1a3c768b3f1a2037"):
the previous cache for baselines and the fresh one for every comparison.
[requireKnownFlags](../../src/commands/common.ts "c2d:src/commands/common.ts#requireKnownFlags:2b1e9560da637e34.38263f8b17ea9305")
rejects a typo'd flag or stray argument with exit 3: a silently ignored
flag would change what the command checks or writes without saying so.
[staleBuildNote](../../src/commands/common.ts "c2d:src/commands/common.ts#staleBuildNote:7bd4d8226fed3487.280b4c1e20fbcb38")
compares the running build's dist against its own src — sources newer
than the build yield the advisory `→ dist is older than src — rebuild
(npm run build) before trusting this report`, carried as the report's
top-level `note`; the check cannot apply outside a dev checkout, since
the published package ships dist alone.
[requireFreshBuild](../../src/commands/common.ts "c2d:src/commands/common.ts#requireFreshBuild:9474c9ce2dd9a671.02e87398405a31d5")
is the write commands' hard form of the same check: init and refresh
sign fingerprints into the doc tree, and fingerprints signed by an
older build are wrong data, not weak advice — refuse with exit 3.
Every public export of `src/commands/` is anchored here (the
**Missing** guarantee for this module).

## `init.ts` — set a repo up

[runInit](../../src/commands/init.ts "c2d:src/commands/init.ts#runInit:b9a5aa6abd9d8b1c.3ba0878b736eb6b3") is idempotent scaffolding:
it writes config, manifest and doc-tree README only when absent, scans
the repo, persists the cache, appends the cache dir to `.gitignore`,
then prints one JSON report and exits 0. The report is the Operator's
planning surface: per-directory module stats plus **every public symbol
with its fingerprint**, ready to be pasted into anchors. A build older
than its own sources refuses the whole write (exit 3) — the symbol
index it would hand the Operator would carry an older extractor's
fingerprints.

- [ModuleReport](../../src/commands/init.ts "c2d:src/commands/init.ts#ModuleReport:c4cc0e9af27b0da6.c4cc0e9af27b0da6") — one source directory: file count, public symbol names, internal count
- [InitReport](../../src/commands/init.ts "c2d:src/commands/init.ts#InitReport:c21ef6755c6d27a5.c21ef6755c6d27a5") — paths, files scanned, modules, public/internal totals, the symbol list

## `status.ts` — the verification pass

[runStatus](../../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:0741c9365da1f37f.8241da30d99edad6") brings the cache to
current state, validates the manifest and reports every declared page:
anchors verified (fresh ones additionally checked for **Ripple**), doc
links existence-checked, module pages audited for uncovered public
exports. Default output is a per-page freshness table plus drill-down
details; `--json` prints the same report machine-read. A build older
than its own sources adds the advisory `note` to both outputs instead
of trusting itself, and the exit tier ignores it — advice never gates.
Exit codes: 0
clean, 1 Drift or Ripple, 2 any Broken or Missing — gated by
`--fail-on <classes>`: only the listed classes tier the run, so a tree
can accumulate Drift while CI still blocks on Broken (`all`, the
default, keeps every class).

- [PageState](../../src/commands/status.ts "c2d:src/commands/status.ts#PageState:2941edf508871e40.2941edf508871e40") — a page's state is the worst of its anchors
- [AnchorReport](../../src/commands/status.ts "c2d:src/commands/status.ts#AnchorReport:a3986c4e45e7c303.a3986c4e45e7c303") — one anchor: symbol, state, reason, ripples, candidates, advisory note, line
- [LinkReport](../../src/commands/status.ts "c2d:src/commands/status.ts#LinkReport:4942d478f8423140.4942d478f8423140") — one doc link: target, resolved path, state, reason, line
- [PageReport](../../src/commands/status.ts "c2d:src/commands/status.ts#PageReport:1e2873ac1a19bd02.1e2873ac1a19bd02") — one page: anchors, links, missing symbols, optional note
- [StatusReport](../../src/commands/status.ts "c2d:src/commands/status.ts#StatusReport:7f5fa48f16728cf7.7f5fa48f16728cf7") — pages plus the broken/drift/ripple/missing summary and the optional build-advisory note

The walk through a single check is a [flow](../flows/status-check.md);
the machinery it calls lives in the [core module](core.md).

## `refresh.ts` — the reviewed re-sign

[runRefresh](../../src/commands/refresh.ts "c2d:src/commands/refresh.ts#runRefresh:6d00252be1ee403d.14bd6235521d3666") is the
maintenance half of the loop: it brings the cache to current state,
then re-signs every manifest-declared anchor whose symbol kept its
signature but whose body moved — the recorded verdict that a reviewed
Drift claim still holds. A build older than its own sources is refused
outright (exit 3): re-signing from an older extractor would write
fingerprints the current build will not recognize. It never masks
**Broken** (ADR-0007): a
changed signature, a vanished symbol or a missing page file comes back
as an [UnresolvedEntry](../../src/commands/refresh.ts "c2d:src/commands/refresh.ts#UnresolvedEntry:0a2e1ff42de50304.0a2e1ff42de50304") —
located, reasoned, never re-signed (a page-level finding carries no
symbol) — and fails the run with the Broken report code (exit 2); only
a claim rewrite resolves those. `--json`
prints the [RefreshReport](../../src/commands/refresh.ts "c2d:src/commands/refresh.ts#RefreshReport:cc6354922a3c53cb.cc6354922a3c53cb"):
`refreshed` and `unresolved` lists of
[RefreshEntry](../../src/commands/refresh.ts "c2d:src/commands/refresh.ts#RefreshEntry:32a64814d56ae313.32a64814d56ae313")
locations.

Back to the [overview](../overview.md).
