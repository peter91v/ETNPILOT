# 0003 — A project is trusted once per change, before its commands act

**Decided.** The first time a project is used on a machine, and whenever its configuration, plugin code or other
non-content files change, commands that act on it show what it can do and ask once. Reading commands never ask.

**Why.** A project directory is executable in effect: it names commands, plugins and hosts. Running `etnpilot` in
a freshly cloned repository should not be the moment that is decided for you.

**Cost.** One extra question after each change to the committed configuration. Pipelines opt out with
`ETNPILOT_TRUST=all`. Tests skip the gate unless `ETNPILOT_TRUST=enforce`.
