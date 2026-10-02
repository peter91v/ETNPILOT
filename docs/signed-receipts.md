# Signed receipt chains

ETNPilot can sign every entry in a run receipt with Ed25519. The existing SHA-256 chain still links
each JSONL entry to the previous one. A signed entry also includes a versioned proof descriptor in
the hashed payload and an Ed25519 signature over a domain-separated hash.

The public-key fingerprint is the key ID. Verification trusts an external public key, not key
material embedded in the receipt. This prevents an attacker from replacing both a receipt and its
claimed signer.

## Generate a key pair

```bash
etnpilot receipt keygen --root /path/to/project
```

The default paths are:

- private key: `.etnpilot/keys/receipt-signing-private.pem`;
- public key: `.etnpilot/receipt-signing-public.pem`.

The private-key directory is excluded by the generated `.etnpilot/.gitignore`. On POSIX systems,
ETNPilot creates the private key with mode `0600` and refuses to use it when group or other users
can read it. The public key is intentionally shareable and may be committed or distributed through
a trusted channel.

Key generation never overwrites existing files.

## Enable signing

```yaml
receipts:
  signing:
    enabled: true
    privateKeyFile: .etnpilot/keys/receipt-signing-private.pem
    publicKeyFile: .etnpilot/receipt-signing-public.pem
```

`ETNPILOT_RECEIPT_SIGNING_KEY_FILE` may override the private-key path at runtime. Store only the
path in configuration, never the private key itself.

The signing key can alternatively use a named secret reference. This keeps the consumer
configuration unchanged when the backend changes:

```yaml
secrets:
  providers:
    signing-files:
      type: file
      root: .etnpilot/keys
      requireOwnerOnly: true
  values:
    receipt.signingKey: { provider: signing-files, key: receipt-signing-private.pem }
receipts:
  signing:
    enabled: true
    privateKeySecret: receipt.signingKey
    publicKeyFile: .etnpilot/receipt-signing-public.pem
```

When `privateKeySecret` is present it takes precedence over `privateKeyFile` and the environment
path override. The resolved value is used in memory and is not written to run receipts.

## Verify a receipt

```bash
etnpilot receipt verify .etnpilot/state/runs/<run-id>.jsonl --root /path/to/project
```

When a public key is available, CLI verification is strict by default: every entry must have a valid
signature and the final entry must be the signed workflow terminal. This detects modified entries,
broken links, untrusted keys, removed signatures, appended data, and truncated tails.

For migration or crash inspection:

```bash
# Verify an older hash-only receipt
etnpilot receipt verify old-run.jsonl --allow-unsigned --allow-incomplete

# Require both guarantees explicitly
etnpilot receipt verify run.jsonl --public-key trusted.pem \
  --require-signatures --require-terminal
```

An incomplete file can still have a valid signed prefix after a hard crash. `--allow-incomplete`
reports that prefix without claiming the workflow reached its terminal receipt.

## What a run writes

Besides each agent's own receipt and the sealing `workflow` entry, a run writes two kinds of entry that say
what state it was in:

- `run-start` (the first): `configDigest`, a SHA-256 over the effective configuration, `workspaceDigest`,
  the state of the working tree when the steps began, `plan` (the steps, their types and what each needs) and
  `workspace` (path and branch), `request` (what was asked: the task, agent or workflow, overrides) and, for a
  resumed run, `resumedFrom` (the earlier run, the last hash of its receipt, and the steps carried over).
- `step` (one per finished step; `reused` names the earlier run and entry when the step was carried over instead
  of run): the step, its type, an `effect` label (`workspace`, `read`, or `external` when
  the step was approved to use the network) and the `workspaceDigest` it left behind.

A workspace digest is `git:<HEAD>:<tree>`, where the tree covers everything git would add (tracked changes and
untracked files that are not ignored). It is taken in a throwaway copy of the index, so the staging area and the
files are not touched. Where it cannot be taken (not a git working tree) the entry says `unavailable` and why;
the run goes on. These entries are evidence for a reader, and the groundwork for resuming a run
(`docs/entwurf-lauf-fortsetzen.md`); `etnpilot resume <run>` reads them. Resuming never appends to the old chain: it writes a new run that points back. Receipts written before they existed stay valid.

## Canonical encoding

Entries are hashed over canonical JSON: object keys sorted, `undefined` values omitted, no
insignificant whitespace. An independent verifier can therefore rebuild exactly the bytes that were
hashed and signed without depending on JavaScript key order. Receipts written before this encoding
was introduced remain verifiable; `etnpilot receipt verify` reports `encoding: "mixed"` and counts
them as `legacyEntries`.

## Rotation and trust

Generate a new pair instead of overwriting a key. Each entry carries the fingerprint of the key that
signed it. Keep old public keys available for historical verification and pass multiple
`--public-key` options when a receipt spans a rotation. Removing an old private key does not affect
verification.

Signatures prove that the holder of the trusted private key produced the receipt and that its signed
contents have not changed. They do not prove that an agent's decision was correct, and they do not
replace operating-system access controls for receipt files or signing keys.

## Limits worth knowing

- **Verification reads line by line**, so a long run is not impossible to check. A single line (one tool call's
  output) may be at most 8 MiB. The run list shows a receipt it cannot read as *unreadable* with the reason, instead
  of leaving the run out. The detail view holds a whole receipt and is limited to 64 MiB; `etnpilot receipt verify`
  has no such limit.
- **Without a public key**, `receipt verify` checks the chain's integrity only, and says so in a `notes` field: a
  chain cut off at its end still verifies unless `--require-terminal` is given, and nothing is known about who wrote it.
- **The signing key lives next to the receipts by default** (`.etnpilot/keys/`). Whoever can write the receipts can
  sign with it. For receipts that must stand against the machine's own user, keep the key elsewhere
  (`receipts.signing.privateKeySecret` with the Vault plugin).
- **No rotation or revocation.** A key is trusted for every receipt it signed, whenever. A start and end date per
  key (checked against the entry's own time, which the local clock supplies) is a sensible next step, but a time
  from the same machine proves little; an external time stamp would be the real answer.
