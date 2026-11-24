# code2doc overview

code2doc is a model-free CLI that keeps an agent-maintained doc tree
honest. The tool never writes a line of documentation — an AI code agent
(the **Operator**) writes every page; code2doc indexes the code's symbols
and verifies the **anchors** the Operator leaves on every factual claim.
When the code moves, the anchors say so.

## Shape

Two commands, dispatched by `src/cli.ts`:

- [runInit](../src/commands/init.ts "c2d:src/commands/init.ts#runInit:b9a5aa6abd9d8b1c.b6702a806487a9e3") sets a repo up: config, an
  empty manifest, a doc-tree skeleton and a symbol index whose public
  symbols carry the fingerprints the Operator will anchor with.
- [runStatus](../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:0741c9365da1f37f.165c5277f56aa760") is the product: it
  re-indexes the code, checks every declared page and reports
  **Broken**, **Drift**, **Ripple** and **Missing** with exit codes
  0/1/2.

The checking machinery lives in the [core module](modules/core.md):
[scan](../src/cache.ts "c2d:src/cache.ts#scan:44a4ee3dd8d89493.4975be28484245ee") builds the symbol cache (file hashes gate
re-parses), [checkAnchor](../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:f32562f5b831fb30.021c2c52dc1e1724") compares an
anchor's fingerprint against the cache, and
[validateManifest](../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c2e93e39bdb17239") guards the
declared page list — shape errors are tool failures, never signals.

Language extraction hides behind one interface:
[extractorForFile](../src/extractor/registry.ts "c2d:src/extractor/registry.ts#extractorForFile:205bcbf1cfc8f4e1.f9cda4200ff97c92") picks
an extractor by extension, and the core never branches on language
again. TS/JS and Java ship at parity — see the
[extractor module](modules/extractor.md).

## Reading further

- Static surface, per module: [core](modules/core.md) ·
  [commands](modules/commands.md) · [extractor](modules/extractor.md)
- Dynamic behavior: [the status check, step by step](flows/status-check.md)
- Practical: [add a new language extractor](howtos/add-a-language.md)
