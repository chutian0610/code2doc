# Core module (`src/`)

The checking machinery: config, manifest, symbol cache, anchor and
doc-link verification, call edges, path helpers. `src/cli.ts` lives here too but
exports nothing — it only dispatches to the
[commands](commands.md). Everything below is anchored; this page also
carries the **Missing** guarantee — every public export of `src/` has an
anchor here.

## `anchors.ts` — claims and their verification

An anchor is a plain markdown link whose title carries the whole machine
payload (`c2d:<file>#<name>:<signature>.<body>`); the URL stays a
clickable link for Readers. [parseMarkdownLinks](../../src/anchors.ts "c2d:src/anchors.ts#parseMarkdownLinks:d7a5a94f54c10100.1fa400de5430428d")
finds every inline link, [parseAnchorTitle](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchorTitle:74447079f1dbf865.ecb55f854815015d")
decodes `c2d:` titles, [parseAnchors](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchors:ef56a471973b6c71.83fe700be2c5b454") chains
the two into a page's anchor list. Verification is
[checkAnchor](../../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:693df525b389ace2.3f6fa8c3a096c759"): lookup by file + name only
(cache-local rows never break on line shifts), then signature mismatch →
broken, body mismatch → drift, match → fresh.

- [Anchor](../../src/anchors.ts "c2d:src/anchors.ts#Anchor:727524e555db432b.727524e555db432b") — one parsed anchor: text, target, file, name, fingerprint, line
- [MarkdownLink](../../src/anchors.ts "c2d:src/anchors.ts#MarkdownLink:3ce1f36acb740dac.3ce1f36acb740dac") — any inline link, title optional
- [AnchorPayload](../../src/anchors.ts "c2d:src/anchors.ts#AnchorPayload:95dc76e161fcd68f.95dc76e161fcd68f") — the `c2d:` payload without the link around it
- [AnchorState](../../src/anchors.ts "c2d:src/anchors.ts#AnchorState:931b1fd49c036623.931b1fd49c036623") — `fresh | drift | ripple | broken`, also the page-state ladder
- [AnchorReason](../../src/anchors.ts "c2d:src/anchors.ts#AnchorReason:af8682aecd06428b.af8682aecd06428b") — `''` / `symbol gone` / `signature changed` / `body changed` / `callee went stale`
- [AnchorCheck](../../src/anchors.ts "c2d:src/anchors.ts#AnchorCheck:c87c463cdc3bc96a.c87c463cdc3bc96a") — one check's state plus reason

## `cache.ts` — derived state, rebuildable at any time

[CacheData](../../src/cache.ts "c2d:src/cache.ts#CacheData:abbcd2e46fda7e4c.abbcd2e46fda7e4c") is the whole cache: per-file
content hash plus extracted symbols plus call refs, version-gated so a
foreign algorithm triggers a rebuild instead of poisoning checks.
[scan](../../src/cache.ts "c2d:src/cache.ts#scan:d18e418017cff803.a6ea9cb50d1f281b") globs the config's include/exclude, routes
each file to its extractor and reuses cached symbols and refs whenever
[fileHash](../../src/cache.ts "c2d:src/cache.ts#fileHash:7b8e31f77c8bcd72.eeea8db4839d041e") matches (ADR-0002: file-level
detection, symbol-level semantics). [loadCache](../../src/cache.ts "c2d:src/cache.ts#loadCache:097909b3a2dbffdd.adc5b82b7ebd575d")
and [saveCache](../../src/cache.ts "c2d:src/cache.ts#saveCache:05c31eec37899133.a49d58e681604d3a") persist it under the ignored
`.code2doc/`; [allSymbols](../../src/cache.ts "c2d:src/cache.ts#allSymbols:65cf4a853e7409f4.9c59068f7412a0e4") flattens it for
coverage checks.

## `ripple.ts` — call edges and the cache baseline

[resolveEdges](../../src/ripple.ts "c2d:src/ripple.ts#resolveEdges:f928c71ba22598e0.98455e2b323045b9") runs the ADR-0004
disambiguation cascade over the cached call refs — import resolution →
same-file uniqueness → global-name uniqueness → no edge — where a name
claimed by an import never falls through and an ambiguous name yields
nothing (a missing edge is tolerated, a false edge never is).
[changedSince](../../src/ripple.ts "c2d:src/ripple.ts#changedSince:2666cea6545df679.c5666680021b2283") diffs the previous
status cache into the changed set (gone or signature moved → broken,
body moved → drift; additions are not changes), and
[ripplesUnder](../../src/ripple.ts "c2d:src/ripple.ts#ripplesUnder:0d912deb4c12ffc2.4b5060dcb0557396") propagates it:
reverse single-source reachability from each changed symbol over caller
edges, keeping the shortest path — `via` is the reached symbol's own
callee on it, `depth` its length — so closure cost scales with the
change set, not the anchor count.

- [EdgeMap](../../src/ripple.ts "c2d:src/ripple.ts#EdgeMap:3c402fddea2aa1e0.3c402fddea2aa1e0") — resolved caller → callee keys, both `file#name`
- [ChangeState](../../src/ripple.ts "c2d:src/ripple.ts#ChangeState:34f10af966d35a15.34f10af966d35a15") — `broken | drift`, how a callee moved
- [ChangeMap](../../src/ripple.ts "c2d:src/ripple.ts#ChangeMap:c56448f26ef729c4.c56448f26ef729c4") — symbols that moved since the last status
- [Ripple](../../src/ripple.ts "c2d:src/ripple.ts#Ripple:f6cb35cf89fda1ea.f6cb35cf89fda1ea") — one stale callee with its propagation path (`via`, `depth`)

## `config.ts` — one file, whole scope

[Code2docConfig](../../src/config.ts "c2d:src/config.ts#Code2docConfig:6273b87446a35359.6273b87446a35359") holds include/exclude
globs, doc root and doc language; [loadConfig](../../src/config.ts "c2d:src/config.ts#loadConfig:87899fbd6eb20c86.a928605a0e3983f7")
fills gaps from [defaultConfig](../../src/config.ts "c2d:src/config.ts#defaultConfig:800dfddfa27602a2.7674f7a31618e991") and
[saveConfig](../../src/config.ts "c2d:src/config.ts#saveConfig:7167d8c756ff0d9b.69fc16873d99f8fd") writes
[CONFIG_FILE](../../src/config.ts "c2d:src/config.ts#CONFIG_FILE:eed85beddc3696fd.f9ea712816df3bba") (`code2doc.config.json`).
[CACHE_DIR](../../src/config.ts "c2d:src/config.ts#CACHE_DIR:8c412effebaf70c9.0d6a56f5968394a3") and
[CACHE_FILE](../../src/config.ts "c2d:src/config.ts#CACHE_FILE:18751b3783cb068d.524be56b3505bc19") name the derived-state
location; [configPath](../../src/config.ts "c2d:src/config.ts#configPath:15f51c8f8224248b.150062e2ba1103e6") resolves it against
a repo root.

## `links.ts` — doc-to-doc links

Ordinary markdown links between pages are checked for target existence
only — never semantics. [parseDocLinks](../../src/links.ts "c2d:src/links.ts#parseDocLinks:26178a996c82d648.f9d1589bc70eafdf")
resolves a page's links the way a renderer would (relative to the page's
real directory, skipping externals, same-page fragments, images and
anchors); [checkDocLink](../../src/links.ts "c2d:src/links.ts#checkDocLink:27cbad79803870e7.9ddbeef5665350b7") is the existence
test. A missing target is Broken, like any stale claim.

- [DocLink](../../src/links.ts "c2d:src/links.ts#DocLink:41f218fe30f73807.41f218fe30f73807") — one resolved in-tree link: target as written, resolved path, line
- [LinkState](../../src/links.ts "c2d:src/links.ts#LinkState:674dc3bbb5127167.674dc3bbb5127167") — `fresh | broken`
- [LinkReason](../../src/links.ts "c2d:src/links.ts#LinkReason:a6d8e5b37da287d4.a6d8e5b37da287d4") — `''` / `doc link target missing`
- [LinkCheck](../../src/links.ts "c2d:src/links.ts#LinkCheck:f0f3a76dd8b67e62.f0f3a76dd8b67e62") — state plus reason

## `manifest.ts` — the declared tree

A page exists because the manifest declares it, not because a file
happens to sit in the doc root. [PAGE_TYPES](../../src/manifest.ts "c2d:src/manifest.ts#PAGE_TYPES:7d3e43c21f9576da.a40c99b911d47bc8")
fixes the five types (overview / module / flow / howto / reference); the
type decides the checking policy, and only **module** pages map a source
directory via [PageEntry](../../src/manifest.ts "c2d:src/manifest.ts#PageEntry:dce3b3f26da0d481.dce3b3f26da0d481").
[validateManifest](../../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c59587939818b583") makes shape
violations tool failures that name the offender.
[manifestPath](../../src/manifest.ts "c2d:src/manifest.ts#manifestPath:9af370dee14720d4.f8f1b0637c22ce04"),
[loadManifest](../../src/manifest.ts "c2d:src/manifest.ts#loadManifest:5e1332b8bf04023d.bfc45f9f5785f349"),
[saveManifest](../../src/manifest.ts "c2d:src/manifest.ts#saveManifest:d3521aff761dc207.5e80cbc4018f6eaf") and
[emptyManifest](../../src/manifest.ts "c2d:src/manifest.ts#emptyManifest:bbbc095aba5dfc00.edd5c107277feaa4") are the persistence
plumbing.

- [PageType](../../src/manifest.ts "c2d:src/manifest.ts#PageType:a63e12aca57f45e4.a63e12aca57f45e4") — one of the five types
- [Manifest](../../src/manifest.ts "c2d:src/manifest.ts#Manifest:db148829ec38deef.db148829ec38deef") — the page list Operators plan and evolve

## `paths.ts` — repo-relative hygiene

Repo-internal paths are stored with forward slashes everywhere:
[toPosix](../../src/paths.ts "c2d:src/paths.ts#toPosix:c71ae791332449ff.7a8ede092ddca366") normalizes platform separators,
[dirOf](../../src/paths.ts "c2d:src/paths.ts#dirOf:c9a93759d689b124.f230c611ebde9d94") yields a file's directory (`.` for
root-level files) and [normalizeModuleDir](../../src/paths.ts "c2d:src/paths.ts#normalizeModuleDir:e2ac2b33ce305d3d.13ee230e7cc19518")
canonicalizes a manifest `module` value (no `./` prefix, no trailing
`/`).

Back to the [overview](../overview.md).
