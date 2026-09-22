import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlReceiptStore {
  constructor(path) {
    this.path = path;
    this.pending = Promise.resolve();
  }

  async append(receipt) {
    const operation = this.pending.then(() => this.#append(receipt));
    this.pending = operation.catch(() => {});
    return operation;
  }

  async #append(receipt) {
    await mkdir(dirname(this.path), { recursive: true });
    const previousHash = await this.#lastHash();
    const payload = { ...receipt, previousHash };
    const canonical = JSON.stringify(payload);
    const hash = createHash("sha256").update(canonical).digest("hex");
    await appendFile(this.path, `${JSON.stringify({ ...payload, hash })}\n`, "utf8");
    return hash;
  }

  async #lastHash() {
    const content = await readFile(this.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lastLine = content.trim().split("\n").filter(Boolean).at(-1);
    if (!lastLine) return null;
    const parsed = JSON.parse(lastLine);
    return parsed.hash ?? null;
  }
}
