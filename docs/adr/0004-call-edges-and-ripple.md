# Call edges by name heuristic, Ripple by cache baseline

v2 adds one signal, Ripple: an anchored symbol whose own fingerprint is unchanged but whose transitive callees went stale. The call edges behind it are built by name heuristics, not resolved references — the verifier deliberately settles for an incomplete graph. The governing trade-off is **a missing edge is tolerated, a false edge never is**: a false Ripple kills the Operator's trust and the signal with it, while a missing edge only means one less nudge, and blind spots are documented below instead of hidden. Disambiguation therefore cascades import/using resolution → same-file uniqueness → global-name uniqueness, and an ambiguous name yields no edge.

Edges are extracted from the same tree-sitter parses as symbols (call/member-call expressions by their final identifier, `new`, `extends`/`implements`). Function-as-value references (passing a function instead of calling it) are a blind spot: attributing bare identifiers to scopes is where the noise lives, and the payoff does not justify it. More blind spots, all deliberate: bare package imports (nothing under node_modules is indexed); TS/JS class methods (not symbols — only top-level declarations are, so a method call has no callee candidate); fresh-clone first run of `status` (no cache baseline yet — but on that run every direct Broken/Drift already fires, so only Ripple is absent); and Missing never propagates, because it is a coverage signal, not a code change.

## Considered options for the baseline

- **Cache baseline (chosen)**: a callee "changed" when its current fingerprint differs from the previous `status` cache. Ripple then means "since the last status, something under this anchor moved". Anchor format stays untouched — every v1 doc tree remains valid.
- **Dependency snapshot in the anchor**: hash the callee closure into the anchor at doc time. Rejected: it breaks the anchor grammar, and every new downstream symbol would force rewriting every anchor that names it — the opposite of pages that stay few and stable.
- **git diff**: rejected — code2doc has no git dependency and should not grow one.

## Consequences

- Page states become four: `broken > drift > ripple > fresh`. Ripple shares exit code 1 with Drift ("review recommended" tier); v1 automation semantics are unchanged.
- `CacheData.version` bumps to 3 (old caches rebuild — same guard ADR-0003 established).
- Broken-by-disappearance anchors gain `candidates` (≤3): an exact signature-fingerprint match elsewhere (a pure move/rename) ranks first, then same-name symbols. Advisory only — it changes no exit code. Implementation note (V2-4): the signature fingerprint carries the declaration's name, so a *pure rename* changes it by construction — a third tier, an unchanged body fingerprint, catches exactly that case; tiers rank signature-exact, same-name, body-exact, and within a tier an untouched body ranks first.
