# Upstream provenance

ETNPilot was bootstrapped after reviewing Agentwerk:

- repository: `https://github.com/peter91v/agentwerk`
- reference commit: `87ea7e669b8cc5b24462c297817eb8f139b3eeea`
- reference tree: `dfe4bc3cbf45624ac4b50124ca2cad41f341439a`
- package license declaration: MIT

ETNPilot keeps the useful proof-carrying pipeline principles while implementing an independent harness, embedded code graph, provider API, and GitLab integration. The upstream source is pinned as the `upstream/agentwerk/` Git submodule for traceability during the bootstrap phase and must not be imported by production ETNPilot modules.
