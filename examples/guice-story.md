<!-- A snapshot example: outputs below were recorded against
     @chutian0610/code2doc at its current version and Google Guice at
     its current master. Fingerprints, counts and line numbers will
     drift; the shape of the workflow will not. -->

# A story: documenting Google Guice with your AI agent

I had a codebase I kept re-explaining to my coding agent: Google Guice,
the dependency-injection framework. Every session, the agent re-read
hundreds of Java files to re-derive what `@Singleton` really does and
why bindings behave the way they do. Here is what changed when the
agent started maintaining a living doc tree instead.

## 1. One install, one sentence

The agent reads a skill; the skill teaches it the whole Operator
workflow. Installing is one line in a terminal:

```
npx skills add chutian0610/code2doc
```

Then one sentence to the agent:

> "Follow SKILL.md: document this repo, smallest module first."

That's the whole onboarding. No doc-format negotiation, no template
choice — the skill pins all of it.

## 2. The agent plans, writes and gets told what's missing

The agent ran `code2doc init`, and the tool answered with the raw
material: **260 Java files scanned, 1,199 public symbols**, each with
the fingerprint that makes claims verifiable later. It planned a
minimal manifest — an overview page plus one module page for the core
package — and wrote a first version anchoring the central trio:

- [Injector](https://github.com/google/guice/blob/master/core/src/com/google/inject/Injector.java) — the runtime facade
- [Key](https://github.com/google/guice/blob/master/core/src/com/google/inject/Key.java) — the binding identity
- [AbstractModule](https://github.com/google/guice/blob/master/core/src/com/google/inject/AbstractModule.java) — the DSL applications extend

The first `code2doc status` did not come back green, and that is the
product working:

```
STATE   TYPE       PAGE
fresh   overview   code2doc/overview.md
broken  module     code2doc/modules/inject-core.md

code2doc/modules/inject-core.md (module)
  missing src/com/google/inject/AbstractModule.java#AbstractModule — no anchor on this page
  missing src/com/google/inject/AbstractModule.java#configure — no anchor on this page
  missing src/com/google/inject/Binder.java#Binder — no anchor on this page
  ...
```

`missing` is the coverage contract: a module page promises its
directory's public surface, and the tool counts what the page never
claimed. The agent kept anchoring (or consciously narrowed the module
mapping) until the tree went green.

## 3. Comments moved; the tool didn't blink

During review I added a comment above a method in `Injector.java`.
`status` stayed green — **comment-only edits don't count as changes**.
The fingerprints hash the declaration with comments cut, so docs don't
churn on formatting and prose edits. When my colleague later added a
real method to the interface, `status` flagged exactly one thing:

```
src/com/google/inject/Injector.java#Injector — drift — body changed
```

One edit, one flagged claim, the page and symbol named. I read the
change, decided the claim still held, and had the agent run
`code2doc refresh` — which re-signed the reviewed-drift anchors and
refused anything that needs a rewrite.

Note the coverage contract caught the new method too: the added
`require` method is itself a public symbol now, and it was listed as
`missing` until the page mentioned it.

## 4. Questions become pages

A few days earlier I had asked the agent why a `@Singleton` binding
kept producing fresh instances. The agent answered; this time it also
did what the skill tells it to do with answers worth keeping:

> "Save that as a howto."

It wrote `howtos/singleton-per-injection.md` — the question as the
title, the answer as anchored prose (the claim points at Guice's
`Provider` interface with a real fingerprint). The next session that
hits this problem loads the verified answer instead of re-deriving
DI scope semantics from source.

## 5. What it feels like

The division of labor is the point. **The agent** writes every page
and decides what deserves documenting. **The tool** verifies — a hash
comparison no model can talk its way past. **I** answer the judgment
calls the agent surfaces: does this drifted claim still hold? Is this
module page worth its promise?

Repos don't rot silently anymore. The doc tree is either green, or it
names exactly which claims moved and what to do about them.

---

*This is a snapshot: outputs recorded at the current version of
code2doc and Guice. The workflow shape is durable; the exact numbers
are not. For the machine-facing version of the same loop, see the
transcript that ships with the skill:
[skills/code2doc-operator/transcript.md](../skills/code2doc-operator/transcript.md).*
