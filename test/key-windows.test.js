import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReceiptSigner, createReceiptVerifier, withKeyWindows } from "../src/core/receipt-signing.js";
import { JsonlReceiptStore, verifyReceiptFile } from "../src/core/receipt-store.js";

// A key is trusted for the entries it signed while it was valid. The dates come
// from the entry's own signed time.

const pair = generateKeyPairSync("ed25519");
const signer = createReceiptSigner(pair.privateKey);
const verifier = createReceiptVerifier(pair.publicKey);

async function receiptSignedAt(times, { dated = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "etnpilot-window-"));
  const path = join(dir, "run.jsonl");
  let index = 0;
  const store = new JsonlReceiptStore(path, { signer, now: () => new Date(times[index++]) });
  for (let entry = 0; entry < times.length; entry += 1) await store.append({ kind: "step", n: entry, ...(entry === times.length - 1 ? { terminal: true } : {}) });
  if (!dated) {
    // A receipt from before entries carried a time: the same chain without signedAt,
    // signed again, which is what an older version wrote.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "");
    const old = new JsonlReceiptStore(path, { signer: { ...signer, proof: signer.proof, sign: signer.sign } });
    old.now = () => ({ toISOString: () => undefined });
    for (let entry = 0; entry < times.length; entry += 1) await old.append({ kind: "step", n: entry, ...(entry === times.length - 1 ? { terminal: true } : {}) });
  }
  return path;
}

const keyed = (window) => withKeyWindows(new Map([[verifier.keyId, verifier]]), { [verifier.keyId]: window });
const T = (day) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;

test("a signed entry carries the time it was signed at, inside what is signed", async () => {
  const path = await receiptSignedAt([T(1), T(2)]);
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].proof.signedAt, T(1));
  const report = await verifyReceiptFile(path, { verifiers: new Map([[verifier.keyId, verifier]]), requireSignatures: true, requireTerminal: true });
  assert.equal(report.valid, true);
  // Changing the time breaks the hash, so it cannot be moved into a window.
  const tampered = lines.map((line, index) => (index === 0 ? { ...line, proof: { ...line.proof, signedAt: T(20) } } : line));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${tampered.map((line) => JSON.stringify(line)).join("\n")}\n`);
  assert.equal((await verifyReceiptFile(path, { verifiers: new Map([[verifier.keyId, verifier]]) })).reason, "hash-mismatch");
});

test("a key is trusted inside its window and not outside it", async () => {
  const path = await receiptSignedAt([T(5), T(6)]);
  const verify = (window) => verifyReceiptFile(path, { verifiers: keyed(window), requireSignatures: true, requireTerminal: true });
  assert.equal((await verify({ notBefore: T(1), notAfter: T(10) })).valid, true);
  assert.equal((await verify({ notBefore: T(7) })).reason, "key-not-yet-valid");
  assert.equal((await verify({ notAfter: T(5) })).reason, "key-expired");
  const revoked = await verify({ revokedAt: T(6) });
  assert.equal(revoked.reason, "key-revoked");
  assert.equal(revoked.line, 2, "the entry signed after the revocation, not the one before it");
});

test("entries from before they carried a time are counted, and can be refused", async () => {
  const path = await receiptSignedAt([T(5), T(6)], { dated: false });
  const verifiers = keyed({ revokedAt: T(1) });
  const accepted = await verifyReceiptFile(path, { verifiers, requireSignatures: true, requireTerminal: true });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.undatedEntries, 2);
  const strict = await verifyReceiptFile(path, { verifiers, requireSignatures: true, requireTerminal: true, requireDated: true });
  assert.equal(strict.reason, "undated-entry");
});

test("a key with no window, or a window for an unknown key, changes nothing", async () => {
  const path = await receiptSignedAt([T(5)]);
  assert.equal((await verifyReceiptFile(path, { verifiers: withKeyWindows(new Map([[verifier.keyId, verifier]]), {}), requireTerminal: true })).valid, true);
  assert.equal((await verifyReceiptFile(path, { verifiers: withKeyWindows(new Map([[verifier.keyId, verifier]]), { "sha256:other": { revokedAt: T(1) } }), requireTerminal: true })).valid, true);
});

test("a window that is not a date, or has a field it does not know, is an error", () => {
  const verifiers = new Map([[verifier.keyId, verifier]]);
  assert.throws(() => withKeyWindows(verifiers, { [verifier.keyId]: { notAfter: "next week" } }), /not a date/);
  assert.throws(() => withKeyWindows(verifiers, { [verifier.keyId]: { expires: T(1) } }), /unknown field/);
});
