# The status check, step by step

What happens between `code2doc status` and the exit code — one pass,
anchored along the path it walks. (The same pipeline runs with `--json`;
only the printing differs.)

1. **Load config.** [runStatus](../../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:0741c9365da1f37f.46c435f74d8cd7ed")
   starts in [loadConfig](../../src/config.ts "c2d:src/config.ts#loadConfig:87899fbd6eb20c86.a928605a0e3983f7"); no config file is
   a tool failure ("run `code2doc init` first"), never a signal.

2. **Refresh the index.** [scan](../../src/cache.ts "c2d:src/cache.ts#scan:44a4ee3dd8d89493.4975be28484245ee") globs the
   config's scope and parses every file whose content hash differs from
   what [loadCache](../../src/cache.ts "c2d:src/cache.ts#loadCache:d199be599b896a44.281e32bb0e466c8e") had — unchanged files keep
   their cached symbols, so a fresh clone and a warm one reach the same
   state. [saveCache](../../src/cache.ts "c2d:src/cache.ts#saveCache:5f6e581b2336294e.1d26fc3a62332338") persists it; the cache
   is derived state, safe to delete and rebuild.

3. **Validate the manifest.** [loadManifest](../../src/manifest.ts "c2d:src/manifest.ts#loadManifest:f2c94c8f5ae0433c.bc1af986463367bc")
   plus [validateManifest](../../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c2e93e39bdb17239"): an
   unknown page type or a module page without a `module` mapping is a
   shape error and fails the tool, naming the offender — the manifest is
   Operator-written repo content, not something to soft-report.

4. **Check each declared page.** For every entry:
   [parseAnchors](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchors:f0531fdb78295467.43fd96a4cb258eb7") lifts the `c2d:` titles
   out of the page's links and [checkAnchor](../../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:f32562f5b831fb30.021c2c52dc1e1724")
   resolves each against the fresh index — symbol gone or signature
   changed → Broken, body changed → Drift, match → fresh. An anchor
   that is itself fresh is then checked for **Ripple** (ADR-0004):
   [resolveEdges](../../src/ripple.ts "c2d:src/ripple.ts#resolveEdges:13b5e4b33c6eaa21.8eb8d28601fd8d41") builds the call graph
   from the *previous* cache (the graph as of the last status, so a
   deleted callee still ripples its caller),
   [changedSince](../../src/ripple.ts "c2d:src/ripple.ts#changedSince:d871e26c5986a3b2.ff5de7d8e66e5d60") diffs the two caches,
   and [ripplesUnder](../../src/ripple.ts "c2d:src/ripple.ts#ripplesUnder:7101e46f70922035.e5da30e9c91def8d") walks the change
   set backwards over caller edges, so a ripple reaches any depth and
   names each stale callee with `via` and `depth`. No previous cache —
   fresh clone or foreign version — means no baseline and a
   ripple-silent run.
   [parseDocLinks](../../src/links.ts "c2d:src/links.ts#parseDocLinks:8ad41bf389fb761a.29be1a1aa03017ca") resolves the remaining
   in-tree links and [checkDocLink](../../src/links.ts "c2d:src/links.ts#checkDocLink:3f7eb5da9812d2ce.56906fe279fab0ed") tests
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
