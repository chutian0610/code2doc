# The status check, step by step

What happens between `code2doc status` and the exit code — one pass,
anchored along the path it walks. (The same pipeline runs with `--json`;
only the printing differs.)

1. **Load config.** [runStatus](../../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:c0995b9610c50e1c.0664512ac7dd98e7")
   starts in [loadConfig](../../src/config.ts "c2d:src/config.ts#loadConfig:87899fbd6eb20c86.a928605a0e3983f7"); no config file is
   a tool failure ("run `code2doc init` first"), never a signal.

2. **Refresh the index.** [scan](../../src/cache.ts "c2d:src/cache.ts#scan:d18e418017cff803.a6ea9cb50d1f281b") globs the
   config's scope and parses every file whose content hash differs from
   what [loadCache](../../src/cache.ts "c2d:src/cache.ts#loadCache:097909b3a2dbffdd.adc5b82b7ebd575d") had — unchanged files keep
   their cached symbols, so a fresh clone and a warm one reach the same
   state. [saveCache](../../src/cache.ts "c2d:src/cache.ts#saveCache:05c31eec37899133.a49d58e681604d3a") persists it; the cache
   is derived state, safe to delete and rebuild.

3. **Validate the manifest.** [loadManifest](../../src/manifest.ts "c2d:src/manifest.ts#loadManifest:5e1332b8bf04023d.bfc45f9f5785f349")
   plus [validateManifest](../../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c59587939818b583"): an
   unknown page type or a module page without a `module` mapping is a
   shape error and fails the tool, naming the offender — the manifest is
   Operator-written repo content, not something to soft-report.

4. **Check each declared page.** For every entry:
   [parseAnchors](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchors:ef56a471973b6c71.83fe700be2c5b454") lifts the `c2d:` titles
   out of the page's links and [checkAnchor](../../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:693df525b389ace2.3f6fa8c3a096c759")
   resolves each against the fresh index — symbol gone or signature
   changed → Broken, body changed → Drift, match → fresh. An anchor
   that is itself fresh is then checked for **Ripple** (ADR-0004):
   [resolveEdges](../../src/ripple.ts "c2d:src/ripple.ts#resolveEdges:649f5829f247477c.27edceae99fc4d5c") builds the call graph
   from the *previous* cache (the graph as of the last status, so a
   deleted callee still ripples its caller),
   [changedSince](../../src/ripple.ts "c2d:src/ripple.ts#changedSince:ca5ea69ee3bdc6b7.1b88c85973b5bb5b") diffs the two caches,
   and [ripplesUnder](../../src/ripple.ts "c2d:src/ripple.ts#ripplesUnder:7301f63171cfa2a4.88bc4d1bb1796d33") walks the change
   set backwards over caller edges, so a ripple reaches any depth and
   names each stale callee with `via` and `depth`. No previous cache —
   fresh clone or foreign version — means no baseline and a
   ripple-silent run.
   [parseDocLinks](../../src/links.ts "c2d:src/links.ts#parseDocLinks:26178a996c82d648.f9d1589bc70eafdf") resolves the remaining
   in-tree links and [checkDocLink](../../src/links.ts "c2d:src/links.ts#checkDocLink:27cbad79803870e7.9ddbeef5665350b7") tests
   target existence — a renamed page leaves Broken links behind. A
   **module** page is additionally audited for public exports of its
   mapped directory with no anchor on the page (Missing), and a mapping
   to an unindexed directory is reported Broken rather than silently
   fresh. A page's own state is the worst of all of the above.

5. **Report and gate.** The table shows every page's state; details
   drill into each stale anchor (rippled ones naming the callee), broken
   link and missing symbol with reasons. Exit code: **0** all accurate,
   **1** Drift or Ripple, **2** any Broken or Missing — automation gates
   on severity, humans read the table.

The inputs to this flow come from [init](../modules/commands.md); the
machinery is the [core module](../modules/core.md).
