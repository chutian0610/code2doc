# Commands module (`src/commands/`)

The two Operator entrypoints behind `src/cli.ts`. Each is one `run`
function plus the JSON types it prints — the stdout contracts are the
tool's public interface. Every public export of `src/commands/` is
anchored here (the **Missing** guarantee for this module).

## `init.ts` — set a repo up

[runInit](../../src/commands/init.ts "c2d:src/commands/init.ts#runInit:b9a5aa6abd9d8b1c.b6702a806487a9e3") is idempotent scaffolding:
it writes config, manifest and doc-tree README only when absent, scans
the repo, persists the cache, appends the cache dir to `.gitignore`,
then prints one JSON report and exits 0. The report is the Operator's
planning surface: per-directory module stats plus **every public symbol
with its fingerprint**, ready to be pasted into anchors.

- [ModuleReport](../../src/commands/init.ts "c2d:src/commands/init.ts#ModuleReport:c4cc0e9af27b0da6.c4cc0e9af27b0da6") — one source directory: file count, public symbol names, internal count
- [InitReport](../../src/commands/init.ts "c2d:src/commands/init.ts#InitReport:c21ef6755c6d27a5.c21ef6755c6d27a5") — paths, files scanned, modules, public/internal totals, the symbol list

## `status.ts` — the verification pass

[runStatus](../../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:0741c9365da1f37f.165c5277f56aa760") brings the cache to
current state, validates the manifest and reports every declared page:
anchors verified (fresh ones additionally checked for **Ripple**), doc
links existence-checked, module pages audited for uncovered public
exports. Default output is a per-page freshness table plus drill-down
details; `--json` prints the same report machine-read. Exit codes: 0
clean, 1 Drift or Ripple, 2 any Broken or Missing — gated by
`--fail-on <classes>`: only the listed classes tier the run, so a tree
can accumulate Drift while CI still blocks on Broken (`all`, the
default, keeps every class).

- [PageState](../../src/commands/status.ts "c2d:src/commands/status.ts#PageState:2941edf508871e40.2941edf508871e40") — a page's state is the worst of its anchors
- [AnchorReport](../../src/commands/status.ts "c2d:src/commands/status.ts#AnchorReport:a3986c4e45e7c303.a3986c4e45e7c303") — one anchor: symbol, state, reason, ripples, candidates, advisory note, line
- [LinkReport](../../src/commands/status.ts "c2d:src/commands/status.ts#LinkReport:4942d478f8423140.4942d478f8423140") — one doc link: target, resolved path, state, reason, line
- [PageReport](../../src/commands/status.ts "c2d:src/commands/status.ts#PageReport:1e2873ac1a19bd02.1e2873ac1a19bd02") — one page: anchors, links, missing symbols, optional note
- [StatusReport](../../src/commands/status.ts "c2d:src/commands/status.ts#StatusReport:55d65e131d23b570.55d65e131d23b570") — pages plus the broken/drift/ripple/missing summary

The walk through a single check is a [flow](../flows/status-check.md);
the machinery it calls lives in the [core module](core.md).

Back to the [overview](../overview.md).
