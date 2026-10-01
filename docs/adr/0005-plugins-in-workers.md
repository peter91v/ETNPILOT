# 0005 — Each plugin runs in its own restricted worker

**Decided.** A plugin loads in a worker process under Node's permission model, with bounded messages, run time,
memory and output. It declares the capabilities it needs and gets nothing else; network and secrets go through
the host, which checks them against the declaration.

**Why.** A plugin is third-party code inside a tool that holds credentials. In-process isolation is not a
boundary in Node.

**Cost.** Calls cross a process boundary, so they are slower and must be serializable. Network access inside the
worker is closed on purpose, including the global `fetch` dispatcher (`docs/plugin-isolation.md`).
