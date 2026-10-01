# 0004 — Almost no runtime dependencies

**Decided.** The runtime depends on `yaml` and the optional CodeGraph package, and on Node's own modules (SQLite,
test runner, fetch, permission model) for everything else.

**Why.** Every dependency is code that runs with the agent's reach and a release channel that can be
compromised. The project's pitch is auditability; a small tree is part of it. `npm audit` has nothing to report
and the install is quick on a phone.

**Cost.** Some things are written by hand (SSE parsing, the Markdown view, glob matching) and need their own tests
(`test/fuzz.test.js`). The CodeGraph platform binary is by far the largest part of `node_modules`.
