# code2doc

Living documentation for codebases, kept by AI code agents.

[![test](https://img.shields.io/github/actions/workflow/status/chutian0610/code2doc/test.yml?branch=main&label=test)](https://github.com/chutian0610/code2doc/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@chutian0610/code2doc.svg)](https://www.npmjs.com/package/@chutian0610/code2doc)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://www.npmjs.com/package/@chutian0610/code2doc)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**code2doc** is a model-free CLI: an AI code agent maintains a small, typed
doc tree for a codebase, and the tool guarantees nothing in it goes silently
stale — every factual claim carries a machine-verifiable anchor to the code.
Works with any coding agent.

## Quick start

Requires Node 20+.

```
npx @chutian0610/code2doc init      # config + manifest + skeleton + symbol fingerprints
# … the agent writes pages, anchoring claims with those fingerprints …
npx @chutian0610/code2doc status    # freshness table for humans
npx @chutian0610/code2doc status --json   # machine report for agents
```

After any code change, the agent re-runs `status`: Broken claims get
rewritten, Drift reviewed, new public symbols documented. The wiring that
makes this automatic — skill install, the standing rule, questions
distilled into howto pages — is one section down: [With an AI
agent](#with-an-ai-agent).

## Supported languages

| Language         | Extensions                 |
| ---------------- | -------------------------- |
| TypeScript / TSX | `.ts` `.tsx`               |
| JavaScript / JSX | `.js` `.jsx` `.mjs` `.cjs` |
| Java             | `.java`                    |

Adding a language is one extractor plus tests — [the
how-to](code2doc/howtos/add-a-language.md) walks through it.

## The problem

When an AI code agent documents a codebase, the docs it writes start
rotting the moment the code moves. Nothing detects that "this claim is
now wrong" — so readers stop trusting agent-written docs entirely, and
every session re-derives context from scratch. Existing doc generators
either produce unanchored prose (verifiable by no one) or are
heavyweight wikis built for humans, not for the agent maintaining them.

## The idea

The agent (the **Operator**) writes and maintains the doc tree; the
tool checks it. Two design rules do most of the work:

- Every factual claim carries an **anchor** — a plain markdown link
  whose title carries a **fingerprint** (two hashes: signature + body)
  of the symbol it points at. Humans click the link; the tool verifies
  the fingerprint. An anchor looks like this in a page:

  ```markdown
  [runStatus](../src/commands/status.ts "c2d:src/commands/status.ts#runStatus:0741c9365da1f37f.d9b570fa2b8e8d3a")
  checks every declared page against the code as it stands.
  ```

  This one is live — it appears in this repo's own
  [dogfooded overview](code2doc/overview.md).

- A **manifest** declares the pages that should exist — few and typed
  (`overview` / `module` / `flow` / `howto` / `reference`), never an
  auto-generated mirror of the code tree.
- The tool never calls an LLM. Zero cost, no API key, agent-agnostic.

## The four signals

`code2doc status` checks every declared page against the code as it
stands and reports:

| Signal   | Meaning                                                        | Action            |
| -------- | -------------------------------------------------------------- | ----------------- |
| Broken   | Anchored symbol gone, or its signature changed                 | Rewrite the claim |
| Drift    | Symbol exists, signature same, body changed                    | Review; refresh the fingerprint if the claim still holds |
| Ripple   | The anchor is fresh but a symbol it calls went stale since the last `status` | Follow `via` to the change; most ripples need nothing |
| Missing  | A module's public symbol with no anchor on its module page     | Document it       |

When the code has moved, `status` prints the per-page table plus a
drill-down with reasons and hints (illustrative — this repo's own tree
is green right now):

```
STATE   TYPE       PAGE
fresh   overview   code2doc/overview.md
drift   module     code2doc/modules/core.md
broken  module     code2doc/modules/extractor.md
fresh   flow       code2doc/flows/status-check.md
fresh   howto      code2doc/howtos/add-a-language.md

code2doc/modules/core.md (module)
  drift   src/cache.ts#scan — body changed

code2doc/modules/extractor.md (module)
  broken  src/extractor/ts.ts#extractorForFile — symbol gone
    → maybe src/extractor/fingerprint.ts#fingerprintOf

6 pages: 1 broken, 1 drift, 0 ripple, 4 fresh.
```

Doc-to-doc links are checked too: a page renamed without its inbound
links is Broken, like any stale claim.

Exit codes: `0` all accurate, `1` Drift or Ripple, `2` any Broken or
Missing — so CI (or the agent itself) can gate on severity.

## With an AI agent

code2doc is model-free by design: **judgment** (what to document,
where to anchor) is the agent's; **verification** (does the claim
still match the code) is a hash comparison no model can talk its way
past. Wiring it up:

1. Install the Operator skill into your agent — one line:

   ```
   npx skills add chutian0610/code2doc
   ```

   [skills.sh](https://skills.sh) detects your coding agent (Claude
   Code, Cursor, Codex, …) and installs the skill where that agent
   reads it. No installer handy? [SKILL.md](skills/code2doc-operator/SKILL.md)
   works copied into a skills folder or referenced from
   AGENTS.md/CLAUDE.md — it teaches the whole Operator workflow.

2. First tree, one sentence to the agent: *"Follow SKILL.md: document
   this repo, smallest module first."* It plans the manifest, writes
   anchored pages and iterates `status` to green.

3. From then on the agent runs `status` before finishing any code
   change and answers the signals per the table above.

4. Questions become durable. Once the agent answers a real question
   about the code, it distills the answer into a `howto` page — the
   question as the title, the answer as anchored prose. Usually this
   happens unprompted (a good answer will be asked again); a nudge
   works too — *"save that as a howto."* Ask *"why does my `@Singleton`
   binding create a new instance per `Provider` injection?"* once, and
   the next session loads the answer as a verified page instead of
   re-deriving the codebase.

The machine interface is `status --json` plus the exit codes; the
`→ maybe` rename hints and `via`/`depth` drill-downs let the agent act
on a signal without re-reading the whole repo.

## In this repo

code2doc documents itself — see [code2doc/overview.md](code2doc/overview.md);
the dogfood tree is guarded by the test suite. Architecture decisions
live in [docs/adr/](docs/adr/).

Found a bug, or want a language supported? Open an
[issue](https://github.com/chutian0610/code2doc/issues).

MIT license.
