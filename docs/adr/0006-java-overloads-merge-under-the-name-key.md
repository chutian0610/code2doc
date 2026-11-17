# Java overloads merge under the name key

Symbols are keyed `file#name` — the one spelling, shared by anchors, call edges and reports (ADR-0003, #18). Java is the first extracted language where two distinct declarations can legally share that key: a method and its overloads have one name inside one file. TS/JS surface no such collision at the symbol level — overload signatures are body-less declarations the extractor does not list, and methods are not symbols there.

#13 filed the merge as a known limitation. Writing it down surfaced something worse: the baseline diff compared declarations pairwise across a name-keyed table, so the first overload's signature was measured against the last one's — different by definition — and any file containing overloads reported that key as changed-broken on **every** status after the first, rippling every caller with a false Broken. A false stale signal, the one thing the model never tolerates.

## Decision

The name key stands. A key that carries several declarations compares as a **set**: the whole group of sorted signature fingerprints moved → broken; signatures equal but bodies moved → drift; sets equal → unchanged (#20). Single-declaration names behave exactly as before.

The rest of the merge consequences are accepted as blind spots of the name-keyed model, documented rather than hidden:

- Anchor verification finds the first declaration in file order — an edit confined to a later overload leaves a directly-anchored claim fresh. The ripple path still catches it (the set moved, so callers hear about it); what can slip through is the direct Drift on the anchored page itself.
- The cascade's same-file step counts two candidates and yields no edge — the never-false rule of ADR-0004 working as intended: a bare call to an overloaded method is genuinely ambiguous by name.
- `missing` may list a public overloaded method's key twice — the signal is right, only doubled.

Separating overloads would mean qualifying the key (parameter shapes), which changes the anchor grammar, the cache shape and the one-spelling invariant across every language and every existing page — costs paid to sharpen a signal that has not yet misled anyone in practice.

## Consequences

- An Operator anchoring an overloaded Java method anchors the first declaration; a claim about a specific overload should say which in its own text.
- Revisit when a real codebase shows an overload edit leaving a directly-anchored page fresh that should have drifted: the fix is a qualified key plus a cache-version bump, decided then with evidence.
