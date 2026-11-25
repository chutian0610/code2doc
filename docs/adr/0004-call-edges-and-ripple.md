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

## Amendment: member calls stop guessing (#26)

The global-name-uniqueness step originally treated a member call's final identifier like a bare name. Field-testing on three real repos measured what that step did with member-call names: on the TS side, 21 of 21 edges minted this way were false (`scope.run()` reaching a release script, `store.double`, `console.warn`, `Object.is`) — methods are not symbols in that language family, so a globally-unique name is almost always someone else's method. On Java the same shape is mostly true (methods are symbols; `gson.getDelegateAdapter()` genuinely calls `Gson#getDelegateAdapter`), so Java keeps it.

The rule since cache v7, expressed entirely at the extractor seam: a language whose methods are not symbols reports a member call only when the receiver chain bottoms out in a **namespace import** — `ns.fn()` becomes a named claim on the module's source, resolved precisely by import resolution instead of guessed. Every other member-call name is simply not reported; the cascade itself is unchanged. The never-false rule gains a sharper edge at the cost of a documented blind spot (a same-file or global function invoked as a member on a non-namespace receiver is no longer detected — no measured case of that exists in the field data).

## Amendment: Java's receiver-type rule (#41)

The second field audit (Guice, gson, HikariCP; 6,619 edges; 90 cross-file edges hand-verified) overturned the first amendment's "Java mostly true" judgment: **13 of 90 sampled edges (~14%) were false**, every one a member call whose receiver is a JDK or library type (`SECONDS.toMillis()` reaching `ClockSource#toMillis`), an inner-class name (`Impl.createAdapter()` reaching the outer class's same-named method — inner-class methods are not symbols, so the name is falsely unique), or a collection container (`Set.add()` reaching `WeakKeySet#add`). Java's methods being symbols helps only when the receiver actually is one of them; the name heuristic never checks that it is.

The rule since cache v10, again at the extractor seam: a member call reports only when its receiver's **type names a repo symbol** — same-file top-level types claim bare, imported types claim against the import's FQCN (resolveImport settles repo vs external), and every other type name claims as same-package, resolved by the package-path suffix first and falling back to the uniquely-named file when one package is laid across source roots. Inner-class types, chained call results and undeclared receivers with no backing file report nothing. Blind spots this buys: a member call on a receiver whose type is only knowable through inheritance (a `protected` field declared in a parent class) is no longer detected, and neither is any chained tail — measured, both were worth trading for the false edges they had been masking.
