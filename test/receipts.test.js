import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson, JsonlReceiptStore, verifyReceiptFile } from "../src/core/receipt-store.js";
import { createReceiptSigner, createReceiptVerifier } from "../src/core/receipt-signing.js";

test("receipt store serializes concurrent writes into a verifiable hash chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipts-"));
  const path = join(root, "receipts.jsonl");
  const store = new JsonlReceiptStore(path);
  await Promise.all([
    store.append({ sequence: 1 }),
    store.append({ sequence: 2 }),
    store.append({ sequence: 3 }),
  ]);
  const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].previousHash, null);
  for (let index = 0; index < entries.length; index += 1) {
    const { hash, ...payload } = entries[index];
    assert.equal(hash, createHash("sha256").update(canonicalJson(payload)).digest("hex"));
    if (index > 0) assert.equal(entries[index].previousHash, entries[index - 1].hash);
  }
});

test("receipt hashes are independent of key order and stay backward compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-canonical-receipts-"));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');

  // A chain written before canonical hashing must still verify.
  const legacyPath = join(root, "legacy.jsonl");
  const first = { sequence: 1, previousHash: null };
  const firstHash = createHash("sha256").update(JSON.stringify(first)).digest("hex");
  const second = { sequence: 2, terminal: true, previousHash: firstHash };
  const secondHash = createHash("sha256").update(JSON.stringify(second)).digest("hex");
  await writeFile(legacyPath, [
    JSON.stringify({ ...first, hash: firstHash }),
    JSON.stringify({ ...second, hash: secondHash }),
    "",
  ].join("\n"));

  const result = await verifyReceiptFile(legacyPath);
  assert.equal(result.valid, true);
  assert.equal(result.encoding, "mixed");
  assert.equal(result.legacyEntries, 2);
});

test("signed receipt chains verify with a trusted Ed25519 key", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-signed-receipts-"));
  const path = join(root, "receipts.jsonl");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = createReceiptSigner(privateKey);
  const verifier = createReceiptVerifier(publicKey);
  const store = new JsonlReceiptStore(path, { signer });
  await store.append({ type: "agent", sequence: 1 });
  await store.append({ type: "workflow", terminal: true, status: "succeeded" });

  const result = await verifyReceiptFile(path, {
    verifiers: new Map([[verifier.keyId, verifier]]),
    requireSignatures: true,
    requireTerminal: true,
  });
  assert.equal(result.valid, true);
  assert.equal(result.entries, 2);
  assert.equal(result.signed, 2);
  assert.equal(result.unsigned, 0);
  assert.equal(result.terminal, true);
  assert.deepEqual(result.keyIds, [signer.keyId]);
  await assert.rejects(store.append({ sequence: 3 }), /sealed receipt chain/);
});

test("receipt verification detects payload, signature, trust, and truncation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipt-tamper-"));
  const path = join(root, "receipts.jsonl");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = createReceiptSigner(privateKey);
  const verifier = createReceiptVerifier(publicKey);
  const verifiers = new Map([[verifier.keyId, verifier]]);
  const store = new JsonlReceiptStore(path, { signer });
  await store.append({ type: "agent", result: "original" });
  await store.append({ type: "workflow", terminal: true });
  const original = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);

  const payloadPath = join(root, "payload.jsonl");
  await writeFile(payloadPath, `${JSON.stringify({ ...original[0], result: "changed" })}\n${JSON.stringify(original[1])}\n`);
  assert.equal((await verifyReceiptFile(payloadPath, { verifiers })).reason, "hash-mismatch");

  const signaturePath = join(root, "signature.jsonl");
  await writeFile(signaturePath, `${JSON.stringify({ ...original[0], signature: "AAAA" })}\n${JSON.stringify(original[1])}\n`);
  assert.equal((await verifyReceiptFile(signaturePath, { verifiers })).reason, "invalid-signature");

  assert.equal((await verifyReceiptFile(path, { verifiers: new Map() })).reason, "untrusted-key");

  const truncatedPath = join(root, "truncated.jsonl");
  await writeFile(truncatedPath, `${JSON.stringify(original[0])}\n`);
  assert.equal((await verifyReceiptFile(truncatedPath, {
    verifiers,
    requireSignatures: true,
    requireTerminal: true,
  })).reason, "terminal-receipt-required");
});

test("legacy unsigned receipts remain verifiable unless signatures are required", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-legacy-receipts-"));
  const path = join(root, "receipts.jsonl");
  const store = new JsonlReceiptStore(path);
  await store.append({ sequence: 1 });
  assert.equal((await verifyReceiptFile(path)).valid, true);
  assert.equal((await verifyReceiptFile(path, { requireSignatures: true })).reason, "signature-required");
});

test("receipt store rejects caller-controlled proof fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipt-reserved-"));
  const store = new JsonlReceiptStore(join(root, "receipts.jsonl"));
  for (const field of ["previousHash", "proof", "hash", "signature"]) {
    await assert.rejects(store.append({ [field]: "forged" }), new RegExp(`'${field}' is reserved`));
  }
  await assert.rejects(store.append({ terminal: "yes" }), /must be boolean/);
});
