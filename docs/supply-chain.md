# Supply-chain gates

Four commands, each answering a question a reviewer would otherwise have to
take on trust. All of them exit non-zero on a finding, so they work as CI gates
and as workflow check steps.

## Dependencies and licenses

```bash
etnpilot deps check --root .
```

Reads each ecosystem where its truth lives — a lockfile says what should be
there, the installed tree says what is:

| Ecosystem | Read from | Licenses |
| --- | --- | --- |
| npm | `node_modules/*/package.json` | yes |
| PyPI | `.venv/lib/*/site-packages/*.dist-info/METADATA` | yes |
| Go | `go.mod` | no |
| Cargo | `Cargo.lock` | no |

Go modules and Cargo lockfiles carry no license metadata at all. Those packages
are inventoried and counted as `unlicensedEcosystem`, never reported as
violations — a finding nobody can act on is noise, and noise gets gates
switched off.

The gate is configured per project:

```yaml
supplyChain:
  licenses:
    allow: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC]
    deny: [AGPL-3.0-only]
    unknown: deny        # default once any license policy exists
  packages:
    deny: ["left-pad", "internal-*"]
```

SPDX expressions are evaluated properly: `MIT OR Apache-2.0` passes an
MIT-only allow-list because the choice is yours, while `MIT AND AGPL-3.0-only`
does not. With no license policy configured the gate enforces nothing.

## SBOM

```bash
etnpilot sbom --out sbom.json
```

Emits a CycloneDX 1.5 document of the installed components. Its serial number
is derived from the component set, so an unchanged tree produces an unchanged
document and a diff means the dependencies actually moved.

## Secret scanning

```bash
etnpilot scan secrets --root .
```

Scans tracked files for high-signal credentials: GitLab and GitHub tokens, AWS
key IDs, private key blocks, Slack, Google and npm tokens, plus quoted
credential-looking literals with high entropy.

The generic rule deliberately requires a quoted literal containing a digit. An
earlier draft flagged `SECRET_PROVIDER_VERSION = SECRET_PROVIDER_API_VERSION`
and test fixtures such as `"must-not-cross-boundary"`; a scanner that cries
wolf gets switched off, and a switched-off scanner protects nothing.

Findings carry a fingerprint and a masked preview, never the value:

```json
{ "path": "src/config.js", "rule": "gitlab-pat", "line": 12, "fingerprint": "69a294b38c3e18a6", "preview": "glpa…TU" }
```

Mark a reviewed false positive inline with `etnpilot:allow-secret`, or record
its fingerprint under `supplyChain.secretScan.allow`.

## Run attestations

```bash
etnpilot attest .etnpilot/state/runs/<run-id>.jsonl --out provenance.json
```

Restates a verified receipt as an in-toto statement with a SLSA provenance
predicate: the files the run changed as subjects with their SHA-256 digests,
the base commit as a resolved dependency, and the receipt itself as a
byproduct. It refuses a receipt that does not verify or whose run never
finished.

The attestation claims nothing the receipt does not record. It is a
restatement in a format other tools understand, not an independent audit.
