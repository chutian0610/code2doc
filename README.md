# code2doc

Living documentation for codebases, kept by AI code agents.

## The problem

When an AI code agent documents a codebase, the docs it writes start
rotting the moment the code moves. Nothing detects that "this claim is
now wrong" — so readers stop trusting agent-written docs entirely, and
every session re-derives context from scratch. Existing doc generators
either produce unanchored prose (verifiable by no one) or are
heavyweight wikis built for humans, not for the agent maintaining them.

## The idea

**code2doc** is a model-free CLI orchestration layer. The agent
(the **Operator**) writes and maintains a small, typed doc tree; the
tool guarantees nothing goes silently stale:

- Every factual claim carries an **anchor** — a plain markdown link
  whose title carries a **fingerprint** (two hashes: signature + body)
  of the symbol it points at. Humans click the link; the tool verifies
  the fingerprint.
- A **manifest** declares the pages that should exist — few and typed
  (`overview` / `module` / `flow` / `howto` / `reference`), never an
  auto-generated mirror of the code tree.
- The tool never calls an LLM. Zero cost, no API key, agent-agnostic.

## The three signals

`code2doc status` checks every declared page against the code as it
stands and reports:

| Signal   | Meaning                                                        | Action            |
| -------- | -------------------------------------------------------------- | ----------------- |
| Broken   | Anchored symbol gone, or its signature changed                 | Rewrite the claim |
| Drift    | Symbol exists, signature same, body changed                    | Review the claim  |
| Missing  | A module's public symbol with no anchor on its module page     | Document it       |

Doc-to-doc links are checked too: a page renamed without its inbound
links is Broken, like any stale claim.

Exit codes: `0` all accurate, `1` Drift-only, `2` any Broken or Missing
— so CI (or the agent itself) can gate on severity.

## The workflow

```
npx @chutian0610/code2doc init      # config + manifest + skeleton + symbol fingerprints
# … the agent writes pages, anchoring claims with those fingerprints …
npx @chutian0610/code2doc status    # freshness table for humans
npx @chutian0610/code2doc status --json   # machine report for agents
```

After any code change, the agent re-runs `status`: Broken claims get
rewritten, Drift reviewed, new public symbols documented. User
questions that got a real answer are distilled into `howto` pages that
age under the same rules. The full operator workflow is taught in
[SKILL.md](SKILL.md) — load it into any coding agent.

## In this repo

code2doc documents itself — see [docs/overview.md](docs/overview.md)
(the dogfood tree is guarded by the test suite). Architecture decisions
live in [docs/adr/](docs/adr/). Currently extracting TypeScript/TSX,
JavaScript/JSX and Java; adding a language is one extractor plus tests
([how](docs/howtos/add-a-language.md)).

MIT license.
