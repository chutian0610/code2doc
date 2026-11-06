# code2doc

code2doc turns a codebase into living documentation. An AI code agent operates the tool; the docs it maintains are read by humans and other agents.

## Language

**Operator**:
The AI code agent that drives code2doc. The only kind of user the tool is designed for.
_Avoid_: user (overloaded — see Reader)

**Reader**:
Anyone who consumes the generated docs: a human onboarding to the codebase, or another agent loading context.

**Accurate**:
A doc is accurate when every factual claim in it is traceable to a code anchor, and any code change that invalidates an anchor marks the doc stale.
_Avoid_: correct, up-to-date (unverifiable senses of "accurate")

**Stale**:
A doc whose anchors no longer match the current code. Staleness is detected and reported, never silently ignored. Two levels: Broken and Drift.

**Broken**:
A stale anchor whose symbol no longer exists or whose signature changed. The claim is likely wrong; rewrite required.
_Avoid_: invalid, dead

**Drift**:
A stale anchor whose symbol still exists with the same signature but a changed body. The claim may be outdated; review recommended.
_Avoid_: outdated (imprecise)

**Fingerprint**:
The identity of a symbol as an anchor target: a pair of hashes — one over the signature, one over the body. Signature change or disappearance → Broken; body-only change → Drift.

**Anchor**:
A machine-verifiable reference from a factual claim in a doc to a code location: a plain markdown link carrying a fingerprint of what it points at. Humans can click it; the tool can check it.
_Avoid_: link, reference (too generic)

**Page**:
A unit of the doc tree, typed (overview / module / flow / howto / reference). Pages are few and precise, declared in the manifest — never an auto-generated mirror of the code tree. The type decides the page's anchor-checking policy.

**Flow**:
A page explaining one core execution path or piece of critical logic — dynamic behavior, as opposed to the static structure of an overview. Anchored along the symbols it walks through; no coverage requirement (which paths deserve a flow is judgment, declared in the manifest).

**Missing**:
A public symbol with zero anchors in its module's page — the doc-gap signal, reported alongside Broken and Drift. Enforced for module pages only.

**Manifest**:
The declared list of pages that should exist. Planned by the operator at init, evolved as the code changes.

**Doc link**:
An ordinary markdown link from one page to another page of the doc tree. Checked for target existence only: a missing target is reported as Broken, like any stale claim. Anchor URLs are never existence-checked.
_Avoid_: dead link

**How-to**:
A page born from a user question, distilled by the operator into anchored markdown. A first-class page: it goes stale like any other.
_Avoid_: FAQ, answer, tutorial

**Ripple**:
An indirect staleness signal: the anchored symbol's own fingerprint is unchanged, but a symbol it (transitively) calls went stale (Broken or Drift). Missing never propagates — it is a coverage signal, not a code change. Evidence weaker than Drift: review recommended, rewrite not implied.
_Avoid_: indirect drift (dilutes Drift), cascade, secondhand

**Call edge**:
A caller→callee relation between symbols, built by name heuristics (import resolution, same-file uniqueness, global-name uniqueness) — not a resolved reference. Deliberately incomplete by design.
_Avoid_: reference, dependency (too generic)

**Blind spot**:
A case the call-edge heuristics intentionally do not cover, where a real dependency yields no edge. Documented, not hidden: a missing edge is tolerated, a false edge never is.
_Avoid_: limitation, bug
