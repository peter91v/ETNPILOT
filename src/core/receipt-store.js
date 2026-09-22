import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlReceiptStore {
  constructor(path) {
    this.path = path;
  }

  async append(receipt) {
    await mkdir(dirname(this.path), { recursive: true });
    const payload = { ...receipt };
    const canonical = JSON.stringify(payload);
    const hash = createHash("sha256").update(canonical).digest("hex");
    await appendFile(this.path, `${JSON.stringify({ ...payload, hash })}\n`, "utf8");
    return hash;
  }
}
