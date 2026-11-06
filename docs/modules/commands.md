# Commands module (`src/commands/`)

The two Operator entrypoints behind `src/cli.ts`. Each is one `run`
function plus the JSON types it prints — the stdout contracts are the
tool's public interface. Every public export of `src/commands/` is
anchored here (the **Missing** guarantee for this module).

## `init.ts` — set a repo up

[runInit](../../src/commands/init.ts "c2d:src/commands/init.ts#runInit:1a8aeb128109ced2.6aa468b5d536f21a") is idempotent scaffolding:
it writes config, manifest and doc-tree README only when absent, scans
the repo, persists the cache, appends the cache dir to `.gitignore`,
then prints one JSON report and exits 0. The report is the Operator's
planning surface: per-directory module stats plus **every public symbol
with its fingerprint**, ready to be pasted into anchors.

- [ModuleReport](../../src/commands/init.ts "c2d:src/commands/init.ts#ModuleReport:c4cc0e9af27b0da6.c4cc0e9af27b0da6") — one source directory: file count, public symbol names, internal count
- [InitReport](../../src/commands/init.ts "c2d:src/commands/init.ts#InitReport:c21ef6755c6d27a5.c21ef6755c6d27a5") — paths, files scanned, modules, public/internal totals, the symbol list

## `status.ts` — the verification pass

[runStatus](../../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:345f4db5dcd4804d.a9d4da851121bf1b") brings the cache to
current state, validates the manifest and reports every declared page:
anchors verified, doc links existence-checked, module pages audited for
uncovered public exports. Default output is a per-page freshness table
plus drill-down details; `--json` prints the same report machine-read.
Exit codes: 0 clean, 1 Drift-only, 2 any Broken or Missing.

- [PageState](../../src/commands/status.ts "c2d:src/commands/status.ts#PageState:2941edf508871e40.2941edf508871e40") — a page's state is the worst of its anchors
- [AnchorReport](../../src/commands/status.ts "c2d:src/commands/status.ts#AnchorReport:8a3c74e4decad0fb.8a3c74e4decad0fb") — one anchor: symbol, state, reason, line
- [LinkReport](../../src/commands/status.ts "c2d:src/commands/status.ts#LinkReport:4942d478f8423140.4942d478f8423140") — one doc link: target, resolved path, state, reason, line
- [PageReport](../../src/commands/status.ts "c2d:src/commands/status.ts#PageReport:1e2873ac1a19bd02.1e2873ac1a19bd02") — one page: anchors, links, missing symbols, optional note
- [StatusReport](../../src/commands/status.ts "c2d:src/commands/status.ts#StatusReport:361da8ee7306249c.361da8ee7306249c") — pages plus the broken/drift/missing summary

The walk through a single check is a [flow](../flows/status-check.md);
the machinery it calls lives in the [core module](core.md).

Back to the [overview](../overview.md).
