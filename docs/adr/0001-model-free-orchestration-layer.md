# code2doc is a model-free orchestration layer

The tool never calls an LLM itself. It does the deterministic work — change detection, anchor bookkeeping, staleness reporting, doc-tree scaffolding — while the calling agent's model does all the writing. This keeps the tool zero-cost, key-free, and usable by any agent. A standalone auto-refresh mode (tool-driven LLM calls, e.g. in CI) was rejected for v1; it can be added later as an optional mode without changing this boundary.
