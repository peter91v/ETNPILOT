# Architecture decisions

Short records of decisions that are expensive to reverse, so the reason survives the people who made them.
Each says what was decided, why, and what it costs. Add one when a decision changes how the code must be
written or what a user can rely on; do not rewrite an old one, supersede it with a new one.

| # | Decision |
|---|---|
| [0001](0001-hash-chained-receipts.md) | Receipts are a JSONL hash chain, signing is optional |
| [0002](0002-host-bound-stored-logins.md) | A stored login is sent only to the hosts it was issued for |
| [0003](0003-project-trust.md) | A project is trusted once per change, before its commands act |
| [0004](0004-zero-dependencies.md) | Almost no runtime dependencies |
| [0005](0005-plugins-in-workers.md) | Each plugin runs in its own restricted worker |
