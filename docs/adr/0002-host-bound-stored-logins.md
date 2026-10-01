# 0002 — A stored login is sent only to the hosts it was issued for

**Decided.** Keys saved by `etnpilot login` carry the hosts they belong to. They are sent over https to those hosts
(and any the owner added with `--allow-host`), and to nothing else. Plugins never receive them.

**Why.** A repository's configuration can set any provider `baseUrl`. Without the binding, cloning a repository and
running it could send the saved key to an address the repository chose (reproduced during the October review).

**Cost.** A proxy or gateway needs one explicit command. Keys taken from the environment are not bound, because
the person set the variable for that purpose; `etnpilot doctor` warns when such a key would go to a host that is
not the vendor's.
