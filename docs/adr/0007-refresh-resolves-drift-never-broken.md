# Refresh resolves Drift, never Broken

`refresh` began life as a dogfood script that re-signed every anchor resolvable by `file#name` — including anchors whose symbol's *signature* had changed, which the vocabulary classes as Broken, "rewrite required". Promoting the script to a public command forced the question a dogfood-only tool never had to answer: what is refresh allowed to make disappear from a `status` report?

## Decision

Refresh re-signs **Drift only**: an anchor whose symbol still exists under the same signature but whose body moved, recording that the operator reviewed the change and judged the claim to still hold. A signature-changed or vanished symbol is listed as unresolved and fails the run (`exit 2`, the Broken report code). Broken can only be resolved by rewriting the claim text — refresh has no power to mask it.

The rejected alternative kept the script's accept-all semantics on the theory that "the operator ran refresh, so they reviewed everything". That theory makes refresh exactly the tool that silences the one class the model says cannot be silenced, and the Accurate/Stale chain (ADR-0001) leaks at its weakest link: a claim quoting an old signature would go fresh without anyone rewriting it.

## Consequences

- The dogfood script is deleted; the CLI command is the single implementation.
- After a signature refactor the operator's path is: `status` → rewrite the affected claims → `refresh`. One more step than the script allowed, paid for keeping Broken meaningless-to-mask.
- Unresolved anchors fail the run, so a rename cannot sneak past a refresh in CI.
