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
  the fingerprint. An anchor looks like this in a page:

  ```markdown
  [toDate](../src/toDate/index.ts "c2d:src/toDate/index.ts#toDate:52cf55a51b5f4b02.81c8be41197071a4")
  normalizes any date-like input to a Date.
  ```

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

Doc-to-doc links are checked too: a page renamed without its inbound
links is Broken, like any stale claim.

Exit codes: `0` all accurate, `1` Drift or Ripple, `2` any Broken or
Missing — so CI (or the agent itself) can gate on severity.

## The workflow

Requires Node 20+.

```
npx @chutian0610/code2doc init      # config + manifest + skeleton + symbol fingerprints
# … the agent writes pages, anchoring claims with those fingerprints …
npx @chutian0610/code2doc status    # freshness table for humans
npx @chutian0610/code2doc status --json   # machine report for agents
```

After any code change, the agent re-runs `status`: Broken claims get
rewritten, Drift reviewed, new public symbols documented. User
questions that got a real answer are distilled into `howto` pages that
age under the same rules.

## With an AI agent

code2doc is model-free by design: **judgment** (what to document,
where to anchor) is the agent's; **verification** (does the claim
still match the code) is a hash comparison no model can talk its way
past. Wiring it up:

1. Copy [SKILL.md](SKILL.md) into the repo, or reference it from your
   agent's instructions (AGENTS.md, CLAUDE.md, a skills folder). It
   teaches the whole Operator workflow.
2. First tree, one sentence to the agent: *"Follow SKILL.md: document
   this repo, smallest module first."* It plans the manifest, writes
   anchored pages and iterates `status` to green.
3. From then on the agent runs `status` before finishing any code
   change and answers the signals per the table above.
4. Questions become durable. Ask the agent a real question about the
   code — once it answers, the answer is distilled into a `howto`
   page: the question as the title, the answer as anchored prose.
   Usually the agent does it on its own (a good answer will be asked
   again); a nudge works too — *"save that as a howto."* For example:

   > Why does my `@Singleton` binding create a new instance per
   `Provider` injection?

   The next session loads the tree instead of re-deriving the
   codebase — a fresh page is verified context.

The machine interface is `status --json` plus the exit codes; the
`→ maybe` rename hints and `via`/`depth` drill-downs let the agent act
on a signal without re-reading the whole repo.

## In this repo

code2doc documents itself — see [code2doc/overview.md](code2doc/overview.md);
the dogfood tree is guarded by the test suite. Architecture decisions
live in [docs/adr/](docs/adr/). Adding a language is one extractor
plus tests ([how](code2doc/howtos/add-a-language.md)); currently
TypeScript/TSX, JavaScript/JSX and Java.

MIT license.
