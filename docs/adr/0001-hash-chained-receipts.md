# 0001 — Receipts are a JSONL hash chain, signing is optional

**Decided.** Every run writes one JSONL file. Each entry carries the hash of the one before it (sorted-key JSON,
SHA-256); the last entry of a finished run is marked `terminal`. Ed25519 signatures are an option layered on top.

**Why.** A plain append-only file can be read with any tool, verified in any language, and survives the program
that wrote it. The chain shows accidental edits and truncation without any key management. Signatures are needed
only when the receipts are meant as proof to someone else, and forcing keys on everyone would make the first run
harder for no gain.

**Cost.** Without signing, anyone who can write the files can rewrite the whole chain; `etnpilot doctor` says so.
A long run is a long file, so verification and listing read line by line (`docs/signed-receipts.md`, "Limits").
Deleting old receipts is possible (`etnpilot gc`), and removes the evidence with them.
