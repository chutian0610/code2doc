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
clickable link for Readers. [parseMarkdownLinks](../../src/anchors.ts "c2d:src/anchors.ts#parseMarkdownLinks:505bf6e77f55f3ce.2a47641f2a72a634")
finds every inline link, [parseAnchorTitle](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchorTitle:5d028983559eeac4.b0d678849cd223d0")
decodes `c2d:` titles, [parseAnchors](../../src/anchors.ts "c2d:src/anchors.ts#parseAnchors:f0531fdb78295467.43fd96a4cb258eb7") chains
the two into a page's anchor list. Verification is
[checkAnchor](../../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:f32562f5b831fb30.021c2c52dc1e1724"): lookup by file + name only
(cache-local rows never break on line shifts), then signature mismatch →
broken — with an advisory note naming the first declaration's payload when
the written fingerprint matched a later Java overload (ADR-0006) —,
body mismatch → drift, match → fresh. A vanished symbol gets
advisory rename candidates from
[renameCandidates](../../src/anchors.ts "c2d:src/anchors.ts#renameCandidates:3a0a93fb2a80d634.9031534734018be4"):
the ladder itself is
[worse](../../src/anchors.ts "c2d:src/anchors.ts#worse:418fa878d36b4a46.c85cb1b2c9cf79bf")
defined once, and
[anchorVerdict](../../src/anchors.ts "c2d:src/anchors.ts#anchorVerdict:e22e68f788212727.ff55ae4202c88673")
pairs each state with its reason as one typed fact (ripple only when
the check itself is fresh). A vanished symbol gets advisory rename
candidates: a signature-exact match elsewhere (a pure move), a same-name symbol, or
an unchanged body (a pure rename — the signature carries the name, so
it necessarily changed); ≤3, never a state or an exit code.

- [Anchor](../../src/anchors.ts "c2d:src/anchors.ts#Anchor:e3b6a229485f2286.e3b6a229485f2286") — one parsed anchor: text, target, file, name, fingerprint, line
- [MarkdownLink](../../src/anchors.ts "c2d:src/anchors.ts#MarkdownLink:049f9968c7a34a42.049f9968c7a34a42") — any inline link, title optional
- [AnchorPayload](../../src/anchors.ts "c2d:src/anchors.ts#AnchorPayload:1cedc1ad744641e2.1cedc1ad744641e2") — the `c2d:` payload without the link around it
- [AnchorState](../../src/anchors.ts "c2d:src/anchors.ts#AnchorState:747d5b298d95e83f.747d5b298d95e83f") — `fresh | drift | ripple | broken`, also the page-state ladder
- [AnchorReason](../../src/anchors.ts "c2d:src/anchors.ts#AnchorReason:0000933b2f96387f.0000933b2f96387f") — `''` / `symbol gone` / `signature changed` / `body changed` / `callee went stale`
- [AnchorCheck](../../src/anchors.ts "c2d:src/anchors.ts#AnchorCheck:46f19f10b2c96cdf.46f19f10b2c96cdf") — one check's state plus reason, plus an advisory note when the payload named a later overload (ADR-0006)
- [AnchorVerdict](../../src/anchors.ts "c2d:src/anchors.ts#AnchorVerdict:0467e0ff2cd7e84f.0467e0ff2cd7e84f") — state and reason as one typed fact

## `cache.ts` — derived state, rebuildable at any time

[CacheData](../../src/cache.ts "c2d:src/cache.ts#CacheData:e15bcdfa5cd31d63.e15bcdfa5cd31d63") is the whole cache: per-file
content hash plus extracted symbols plus call refs, version-gated so a
foreign algorithm triggers a rebuild instead of poisoning checks.
[scan](../../src/cache.ts "c2d:src/cache.ts#scan:44a4ee3dd8d89493.9dcbeb02120ffbb1") globs the config's include/exclude, routes
each file to its extractor and reuses cached symbols and refs whenever
[fileHash](../../src/cache.ts "c2d:src/cache.ts#fileHash:7b8e31f77c8bcd72.eeea8db4839d041e") matches (ADR-0002: file-level
detection, symbol-level semantics); an extraction failure rethrows
naming the file — loud, never skipped (#23). [loadCache](../../src/cache.ts "c2d:src/cache.ts#loadCache:d199be599b896a44.9df0f80a9be8a607")
and [saveCache](../../src/cache.ts "c2d:src/cache.ts#saveCache:5f6e581b2336294e.1d26fc3a62332338") persist it under the ignored
`.code2doc/`; [allSymbols](../../src/cache.ts "c2d:src/cache.ts#allSymbols:d6217b9524e24d42.d74afeac0125efae") flattens it for
coverage checks.

## `ripple.ts` — call edges and the cache baseline

[resolveEdges](../../src/ripple.ts "c2d:src/ripple.ts#resolveEdges:13b5e4b33c6eaa21.8eb8d28601fd8d41") runs the ADR-0004
disambiguation cascade over the cached call refs — import resolution →
same-file uniqueness → global-name uniqueness → no edge — where import
resolution dispatches to the file's extractor (ADR-0005: the core knows
no specifier forms), a name claimed by an import never falls through,
and an ambiguous name yields nothing (a missing edge is tolerated, a
false edge never is).
[changedSince](../../src/ripple.ts "c2d:src/ripple.ts#changedSince:d871e26c5986a3b2.ff5de7d8e66e5d60") diffs the previous
status cache into the changed set (gone or signature moved → broken,
body moved → drift; additions are not changes), with a key that carries
several declarations — Java overloads — compared as a whole set so an
unedited pair of overloads never reads as a change (ADR-0006), and
[ripplesUnder](../../src/ripple.ts "c2d:src/ripple.ts#ripplesUnder:7101e46f70922035.e5da30e9c91def8d") propagates it:
reverse single-source reachability from each changed symbol over caller
edges, keeping the shortest path — `via` is the reached symbol's own
callee on it, `depth` its length — so closure cost scales with the
change set, not the anchor count. The pairing itself is one module,
[buildBaseline](../../src/ripple.ts "c2d:src/ripple.ts#buildBaseline:3917156f1257b61e.7cdd4dd3be09987f"):
edges from the previous cache, the diff against the current one — a
callee deleted since the last status still ripples its caller — behind
the single-method [Baseline](../../src/ripple.ts "c2d:src/ripple.ts#Baseline:e5b8deaa90f7a60a.e5b8deaa90f7a60a")
interface the status pass queries.

- [EdgeMap](../../src/ripple.ts "c2d:src/ripple.ts#EdgeMap:8780aa0d09f93d18.8780aa0d09f93d18") — resolved caller → callee keys, both `file#name`
- [ChangeState](../../src/ripple.ts "c2d:src/ripple.ts#ChangeState:115eb126e3e7312d.115eb126e3e7312d") — `broken | drift`, how a callee moved
- [ChangeMap](../../src/ripple.ts "c2d:src/ripple.ts#ChangeMap:a258baa5e9299fa2.a258baa5e9299fa2") — symbols that moved since the last status
- [Ripple](../../src/ripple.ts "c2d:src/ripple.ts#Ripple:4ed595692d938751.4ed595692d938751") — one stale callee with its propagation path (`via`, `depth`)

## `config.ts` — one file, whole scope

[Code2docConfig](../../src/config.ts "c2d:src/config.ts#Code2docConfig:6273b87446a35359.6273b87446a35359") holds include/exclude
globs, doc root and doc language; [loadConfig](../../src/config.ts "c2d:src/config.ts#loadConfig:87899fbd6eb20c86.a928605a0e3983f7")
fills gaps from [defaultConfig](../../src/config.ts "c2d:src/config.ts#defaultConfig:800dfddfa27602a2.2c030f220de4d2c2") and
[saveConfig](../../src/config.ts "c2d:src/config.ts#saveConfig:7167d8c756ff0d9b.69fc16873d99f8fd") writes
[CONFIG_FILE](../../src/config.ts "c2d:src/config.ts#CONFIG_FILE:eed85beddc3696fd.f9ea712816df3bba") (`code2doc.config.json`).
[CACHE_DIR](../../src/config.ts "c2d:src/config.ts#CACHE_DIR:8c412effebaf70c9.0d6a56f5968394a3") and
[CACHE_FILE](../../src/config.ts "c2d:src/config.ts#CACHE_FILE:18751b3783cb068d.524be56b3505bc19") name the derived-state
location; [configPath](../../src/config.ts "c2d:src/config.ts#configPath:15f51c8f8224248b.150062e2ba1103e6") resolves it against
a repo root.

## `links.ts` — doc-to-doc links

Ordinary markdown links between pages are checked for target existence
only — never semantics. [parseDocLinks](../../src/links.ts "c2d:src/links.ts#parseDocLinks:8ad41bf389fb761a.29be1a1aa03017ca")
resolves a page's links the way a renderer would (relative to the page's
real directory, skipping externals, same-page fragments, images and
anchors); [checkDocLink](../../src/links.ts "c2d:src/links.ts#checkDocLink:3f7eb5da9812d2ce.56906fe279fab0ed") is the existence
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
[validateManifest](../../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c2e93e39bdb17239") makes shape
violations tool failures that name the offender.
[manifestPath](../../src/manifest.ts "c2d:src/manifest.ts#manifestPath:50b4047191f461b9.944609c1e3f3b98e"),
[loadManifest](../../src/manifest.ts "c2d:src/manifest.ts#loadManifest:f2c94c8f5ae0433c.bc1af986463367bc"),
[saveManifest](../../src/manifest.ts "c2d:src/manifest.ts#saveManifest:e31c973b403e6e15.ff39d0d9804bea82") and
[emptyManifest](../../src/manifest.ts "c2d:src/manifest.ts#emptyManifest:c785f7561d33954b.f5f6072c231e8671") are the persistence
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
