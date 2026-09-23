import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createReceiptSigner,
  generateReceiptKeyPair,
  loadReceiptSigner,
} from "../src/core/receipt-signing.js";

test("generated receipt keys use safe modes and refuse overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipt-keys-"));
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const generated = await generateReceiptKeyPair({ privateKeyPath, publicKeyPath });
  assert.match(generated.keyId, /^sha256:/);
  if (process.platform !== "win32") {
    assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(publicKeyPath)).mode & 0o777, 0o644);
  }
  await assert.rejects(
    generateReceiptKeyPair({ privateKeyPath, publicKeyPath }),
    (error) => error.code === "EEXIST",
  );
});

test("enabled signing rejects private keys with broad filesystem permissions", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipt-permissions-"));
  const privateKeyPath = join(root, "private.pem");
  await generateReceiptKeyPair({ privateKeyPath, publicKeyPath: join(root, "public.pem") });
  await chmod(privateKeyPath, 0o644);
  await assert.rejects(loadReceiptSigner({
    root,
    config: { receipts: { signing: { enabled: true, privateKeyFile: "private.pem" } } },
  }), /must not be accessible by group or other users/);
});

test("receipt signer rejects non-Ed25519 private keys", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => createReceiptSigner(privateKey), /must use Ed25519/);
});

test("a missing signing key is reported as an action, not an ENOENT", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadReceiptSigner } = await import("../src/core/receipt-signing.js");

  const root = await mkdtemp(join(tmpdir(), "etnpilot-missing-key-"));
  const config = { receipts: { signing: { enabled: true, privateKeyFile: ".etnpilot/keys/missing.pem" } } };

  await assert.rejects(
    () => loadReceiptSigner({ root, config, env: {} }),
    (error) => {
      assert.equal(error.code, "receipt_signing_key_missing");
      assert.match(error.message, /Create one with 'etnpilot receipt keygen'/);
      assert.match(error.message, /set receipts\.signing\.enabled to false/);
      return true;
    },
  );

  // Signing that is switched off needs no key at all.
  assert.equal(await loadReceiptSigner({ root, config: { receipts: { signing: { enabled: false } } }, env: {} }), undefined);
});
