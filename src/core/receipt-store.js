// @ts-check
import { readLastLine, readLines } from "../runtime/jsonl.js";
import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyReceiptSignature } from "./receipt-signing.js";

export class JsonlReceiptStore {
  constructor(path, { signer } = /** @type {any} */ ({})) {
    this.path = path;
    this.signer = signer;
    this.pending = Promise.resolve();
    // The chain's last link, kept after the first read. A receipt file belongs
    // to one run and one writer, so reading the whole file for every entry (it
    // was) made a long run quadratic: 1,600 entries took ten seconds, and a
    // file past the read limit stopped the run.
    this.tail = undefined;
  }

  async append(receipt) {
    const operation = this.pending.then(() => this.#append(receipt));
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  async #append(receipt) {
    assertReceiptPayload(receipt);
    await mkdir(dirname(this.path), { recursive: true });
    this.tail ??= await this.#lastEntry();
    const previous = this.tail;
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
    this.tail = { hash, terminal: payload.terminal === true };
    return hash;
  }

  async #lastEntry() {
    const lastLine = await readLastLine(this.path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return lastLine ? JSON.parse(lastLine) : { hash: null, terminal: false };
  }
}

export async function verifyReceiptFile(path, {
  verifiers = new Map(),
  requireSignatures = false,
  requireTerminal = false,
} = /** @type {any} */ ({})) {
  // Line by line: a receipt is as long as the run was, and a limit on the whole
  // file would make a long run impossible to verify.
  const chain = new ChainVerifier({ verifiers, requireSignatures, requireTerminal });
  try {
    for await (const line of readLines(path)) {
      const failure = chain.push(line);
      if (failure) return failure;
    }
  } catch (error) {
    return verificationFailure("file-read-failed", { message: error.message });
  }
  return chain.finish();
}

export function verifyReceiptText(content, { verifiers = new Map(), requireSignatures = false, requireTerminal = false } = /** @type {any} */ ({})) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const chain = new ChainVerifier({ verifiers, requireSignatures, requireTerminal });
  for (const line of lines) {
    const failure = chain.push(line);
    if (failure) return failure;
  }
  return chain.finish();
}

// The checks, one line at a time, so the same code verifies a string and a file
// of any length.
class ChainVerifier {
  constructor({ verifiers, requireSignatures, requireTerminal }) {
    this.verifiers = verifiers;
    this.requireSignatures = requireSignatures;
    this.requireTerminal = requireTerminal;
    this.previousHash = null;
    this.legacyEntries = 0;
    this.signed = 0;
    this.unsigned = 0;
    this.terminal = false;
    this.count = 0;
    this.keyIds = new Set();
  }

  push(line) {
    const index = this.count;
    const lineNumber = index + 1;
    const counts = () => ({ entries: index, signed: this.signed, unsigned: this.unsigned });
    if (this.terminal) {
      // The entry that sealed the chain was not the last one.
      return verificationFailure("entries-after-terminal", { line: lineNumber - 1, entries: index, signed: this.signed, unsigned: this.unsigned });
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return verificationFailure("invalid-json", { line: lineNumber, ...counts() });
    }
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      return verificationFailure("invalid-entry", { line: lineNumber, ...counts() });
    }
    const { hash, signature, ...payload } = entry;
    if (hash !== receiptHash(payload)) {
      // Receipts written before canonical serialization hashed the payload in
      // file order. They stay verifiable; new entries are always canonical.
      if (hash !== createHash("sha256").update(JSON.stringify(payload)).digest("hex")) {
        return verificationFailure("hash-mismatch", { line: lineNumber, ...counts() });
      }
      this.legacyEntries += 1;
    }
    if (payload.previousHash !== this.previousHash) {
      return verificationFailure("chain-mismatch", { line: lineNumber, ...counts() });
    }
    if (payload.proof || signature) {
      const proof = verifyReceiptSignature({ ...payload, hash, signature }, this.verifiers);
      if (!proof.valid) {
        return verificationFailure(proof.reason, { line: lineNumber, keyId: proof.keyId, ...counts() });
      }
      this.signed += 1;
    } else {
      if (this.requireSignatures) {
        return verificationFailure("signature-required", { line: lineNumber, ...counts() });
      }
      this.unsigned += 1;
    }
    if (payload.proof?.keyId) this.keyIds.add(payload.proof.keyId);
    this.previousHash = hash;
    this.terminal = payload.terminal === true;
    this.count += 1;
    return undefined;
  }

  finish() {
    if (this.count === 0) return verificationFailure("empty-file");
    if (this.requireTerminal && !this.terminal) {
      return verificationFailure("terminal-receipt-required", {
        entries: this.count,
        signed: this.signed,
        unsigned: this.unsigned,
        lastHash: this.previousHash,
      });
    }
    return {
      valid: true,
      entries: this.count,
      encoding: this.legacyEntries === 0 ? "canonical" : "mixed",
      ...(this.legacyEntries > 0 ? { legacyEntries: this.legacyEntries } : {}),
      signed: this.signed,
      unsigned: this.unsigned,
      terminal: this.terminal,
      lastHash: this.previousHash,
      keyIds: [...this.keyIds],
    };
  }
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
