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

## Rotation and trust

Generate a new pair instead of overwriting a key. Each entry carries the fingerprint of the key that
signed it. Keep old public keys available for historical verification and pass multiple
`--public-key` options when a receipt spans a rotation. Removing an old private key does not affect
verification.

Signatures prove that the holder of the trusted private key produced the receipt and that its signed
contents have not changed. They do not prove that an agent's decision was correct, and they do not
replace operating-system access controls for receipt files or signing keys.
