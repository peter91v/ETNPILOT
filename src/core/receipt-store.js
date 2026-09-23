import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyReceiptSignature } from "./receipt-signing.js";

export class JsonlReceiptStore {
  constructor(path, { signer } = {}) {
    this.path = path;
    this.signer = signer;
    this.pending = Promise.resolve();
  }

  async append(receipt) {
    const operation = this.pending.then(() => this.#append(receipt));
    this.pending = operation.catch(() => {});
    return operation;
  }

  async #append(receipt) {
    assertReceiptPayload(receipt);
    await mkdir(dirname(this.path), { recursive: true });
    const previous = await this.#lastEntry();
    if (previous?.terminal === true) throw new Error("Cannot append to a sealed receipt chain.");
    const previousHash = previous?.hash ?? null;
    const payload = {
      ...receipt,
      previousHash,
      ...(this.signer ? { proof: this.signer.proof } : {}),
    };
    const hash = receiptHash(payload);
    const signature = this.signer?.sign(hash);
    await appendFile(this.path, `${JSON.stringify({
      ...payload,
      hash,
      ...(signature ? { signature } : {}),
    })}\n`, "utf8");
    return hash;
  }

  async #lastEntry() {
    const content = await readFile(this.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lastLine = content.trim().split("\n").filter(Boolean).at(-1);
    return lastLine ? JSON.parse(lastLine) : undefined;
  }
}

export async function verifyReceiptFile(path, {
  verifiers = new Map(),
  requireSignatures = false,
  requireTerminal = false,
} = {}) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return verificationFailure("file-read-failed", { message: error.message });
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return verificationFailure("empty-file");
  let previousHash = null;
  let legacyEntries = 0;
  let signed = 0;
  let unsigned = 0;
  let terminal = false;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      return verificationFailure("invalid-json", { line: lineNumber, entries: index, signed, unsigned });
    }
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      return verificationFailure("invalid-entry", { line: lineNumber, entries: index, signed, unsigned });
    }
    const { hash, signature, ...payload } = entry;
    if (hash !== receiptHash(payload)) {
      // Receipts written before canonical serialization hashed the payload in
      // file order. They stay verifiable; new entries are always canonical.
      if (hash !== createHash("sha256").update(JSON.stringify(payload)).digest("hex")) {
        return verificationFailure("hash-mismatch", { line: lineNumber, entries: index, signed, unsigned });
      }
      legacyEntries += 1;
    }
    if (payload.previousHash !== previousHash) {
      return verificationFailure("chain-mismatch", { line: lineNumber, entries: index, signed, unsigned });
    }
    if (payload.proof || signature) {
      const proof = verifyReceiptSignature({ ...payload, hash, signature }, verifiers);
      if (!proof.valid) {
        return verificationFailure(proof.reason, {
          line: lineNumber,
          keyId: proof.keyId,
          entries: index,
          signed,
          unsigned,
        });
      }
      signed += 1;
    } else {
      if (requireSignatures) {
        return verificationFailure("signature-required", { line: lineNumber, entries: index, signed, unsigned });
      }
      unsigned += 1;
    }
    previousHash = hash;
    terminal = payload.terminal === true;
    if (terminal && index !== lines.length - 1) {
      return verificationFailure("entries-after-terminal", {
        line: lineNumber,
        entries: index + 1,
        signed,
        unsigned,
      });
    }
  }
  if (requireTerminal && !terminal) {
    return verificationFailure("terminal-receipt-required", {
      entries: lines.length,
      signed,
      unsigned,
      lastHash: previousHash,
    });
  }
  return {
    valid: true,
    entries: lines.length,
    encoding: legacyEntries === 0 ? "canonical" : "mixed",
    ...(legacyEntries > 0 ? { legacyEntries } : {}),
    signed,
    unsigned,
    terminal,
    lastHash: previousHash,
    keyIds: [...new Set(lines.map((line) => JSON.parse(line).proof?.keyId).filter(Boolean))],
  };
}

// Receipts are hashed over sorted-key JSON so an independent verifier in any
// language can rebuild the exact bytes that were signed.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function receiptHash(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function verificationFailure(reason, details = {}) {
  return { valid: false, reason, ...details };
}

function assertReceiptPayload(receipt) {
  if (!receipt || Array.isArray(receipt) || typeof receipt !== "object") {
    throw new TypeError("A receipt must be an object.");
  }
  for (const field of ["previousHash", "proof", "hash", "signature"]) {
    if (Object.hasOwn(receipt, field)) throw new Error(`Receipt field '${field}' is reserved.`);
  }
  if (Object.hasOwn(receipt, "terminal") && typeof receipt.terminal !== "boolean") {
    throw new TypeError("Receipt field 'terminal' must be boolean.");
  }
}
