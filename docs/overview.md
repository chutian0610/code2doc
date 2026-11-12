# code2doc overview

code2doc is a model-free CLI that keeps an agent-maintained doc tree
honest. The tool never writes a line of documentation — an AI code agent
(the **Operator**) writes every page; code2doc indexes the code's symbols
and verifies the **anchors** the Operator leaves on every factual claim.
When the code moves, the anchors say so.

## Shape

Two commands, dispatched by `src/cli.ts`:

- [runInit](../src/commands/init.ts "c2d:src/commands/init.ts#runInit:1a8aeb128109ced2.6aa468b5d536f21a") sets a repo up: config, an
  empty manifest, a doc-tree skeleton and a symbol index whose public
  symbols carry the fingerprints the Operator will anchor with.
- [runStatus](../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:c0995b9610c50e1c.2211906181ad6c9f") is the product: it
  re-indexes the code, checks every declared page and reports
  **Broken**, **Drift**, **Ripple** and **Missing** with exit codes
  0/1/2.

The checking machinery lives in the [core module](modules/core.md):
[scan](../src/cache.ts "c2d:src/cache.ts#scan:d18e418017cff803.f17113f4fd26a12b") builds the symbol cache (file hashes gate
re-parses), [checkAnchor](../src/anchors.ts "c2d:src/anchors.ts#checkAnchor:693df525b389ace2.3f6fa8c3a096c759") compares an
anchor's fingerprint against the cache, and
[validateManifest](../src/manifest.ts "c2d:src/manifest.ts#validateManifest:41444e9a05a7d3f9.c59587939818b583") guards the
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
