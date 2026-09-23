import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const RECEIPT_PROOF_VERSION = 1;
export const RECEIPT_SIGNATURE_ALGORITHM = "Ed25519";
const SIGNATURE_DOMAIN = "etnpilot-receipt-v1:";

export function createReceiptSigner(privateKeyInput) {
  const privateKey = privateKeyInput?.type === "private" ? privateKeyInput : createPrivateKey(privateKeyInput);
  assertEd25519(privateKey);
  const publicKey = createPublicKey(privateKey);
  const keyId = receiptKeyId(publicKey);
  return Object.freeze({
    keyId,
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    proof: Object.freeze({
      version: RECEIPT_PROOF_VERSION,
      algorithm: RECEIPT_SIGNATURE_ALGORITHM,
      keyId,
    }),
    sign(hash) {
      assertHash(hash);
      return sign(null, signaturePayload(hash), privateKey).toString("base64");
    },
  });
}

export function createReceiptVerifier(publicKeyInput) {
  const publicKey = publicKeyInput?.type === "public" ? publicKeyInput : createPublicKey(publicKeyInput);
  assertEd25519(publicKey);
  const keyId = receiptKeyId(publicKey);
  return Object.freeze({
    keyId,
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    verify(hash, signature) {
      assertHash(hash);
      if (typeof signature !== "string" || signature.length === 0) return false;
      try {
        const bytes = Buffer.from(signature, "base64");
        if (bytes.length !== 64 || bytes.toString("base64") !== signature) return false;
        return verify(null, signaturePayload(hash), publicKey, bytes);
      } catch {
        return false;
      }
    },
  });
}

export async function loadReceiptSigner({ root, config = {}, env = process.env, secretResolver } = {}) {
  const signing = config.receipts?.signing ?? {};
  if (signing.enabled !== true) return undefined;
  if (signing.privateKeySecret) {
    if (!secretResolver) throw new Error("Receipt signing uses a secret reference but no resolver is available.");
    return createReceiptSigner(await secretResolver.get(signing.privateKeySecret, { required: true }));
  }
  const configuredPath = env.ETNPILOT_RECEIPT_SIGNING_KEY_FILE ?? signing.privateKeyFile;
  if (!configuredPath) {
    throw new Error("Receipt signing is enabled but no private key file is configured.");
  }
  const path = resolve(root, configuredPath);
  try {
    await assertPrivateKeyPermissions(path);
    return createReceiptSigner(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const missing = new Error(
      `Receipt signing is enabled but its key is missing: ${path}.`
      + " Create one with 'etnpilot receipt keygen', or set receipts.signing.enabled to false.",
    );
    missing.code = "receipt_signing_key_missing";
    missing.cause = error;
    throw missing;
  }
}

export async function loadReceiptVerifiers(paths) {
  const verifiers = new Map();
  for (const path of paths) {
    const verifier = createReceiptVerifier(await readFile(resolve(path), "utf8"));
    if (verifiers.has(verifier.keyId)) throw new Error(`Duplicate receipt verification key '${verifier.keyId}'.`);
    verifiers.set(verifier.keyId, verifier);
  }
  return verifiers;
}

export async function generateReceiptKeyPair({ privateKeyPath, publicKeyPath } = {}) {
  if (!privateKeyPath || !publicKeyPath) throw new TypeError("Private and public key paths are required.");
  const privatePath = resolve(privateKeyPath);
  const publicPath = resolve(publicKeyPath);
  if (privatePath === publicPath) throw new Error("Private and public key paths must be different.");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  await Promise.all([
    mkdir(dirname(privatePath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(publicPath), { recursive: true }),
  ]);
  await writeFile(privatePath, privatePem, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(publicPath, publicPem, { flag: "wx", mode: 0o644 });
  } catch (error) {
    await rm(privatePath, { force: true });
    throw error;
  }
  await Promise.all([chmod(privatePath, 0o600), chmod(publicPath, 0o644)]);
  return {
    keyId: receiptKeyId(publicKey),
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
  };
}

export function receiptKeyId(keyInput) {
  const key = keyInput?.type === "public" ? keyInput : createPublicKey(keyInput);
  assertEd25519(key);
  const der = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("base64url")}`;
}

export function verifyReceiptSignature(entry, verifiers) {
  const proof = entry?.proof;
  if (!proof) return { valid: false, reason: "signature-required", keyId: undefined };
  if (proof.version !== RECEIPT_PROOF_VERSION || proof.algorithm !== RECEIPT_SIGNATURE_ALGORITHM) {
    return { valid: false, reason: "unsupported-proof", keyId: proof.keyId };
  }
  const verifier = verifiers.get(proof.keyId);
  if (!verifier) return { valid: false, reason: "untrusted-key", keyId: proof.keyId };
  return verifier.verify(entry.hash, entry.signature)
    ? { valid: true, keyId: proof.keyId }
    : { valid: false, reason: "invalid-signature", keyId: proof.keyId };
}

async function assertPrivateKeyPermissions(path) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Receipt signing key is not a regular file: ${path}`);
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error(`Receipt signing key must not be accessible by group or other users: ${path}`);
  }
}

function signaturePayload(hash) {
  return Buffer.from(`${SIGNATURE_DOMAIN}${hash}`, "utf8");
}

function assertEd25519(key) {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Receipt keys must use Ed25519.");
}

function assertHash(hash) {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new TypeError("A lowercase SHA-256 receipt hash is required.");
  }
}
