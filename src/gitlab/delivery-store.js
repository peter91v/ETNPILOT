import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class WebhookDeliveryStore {
  constructor(directory) {
    this.directory = directory;
  }

  async claim(deliveryId, metadata = {}) {
    if (!deliveryId) throw new TypeError("A webhook delivery ID is required.");
    await mkdir(this.directory, { recursive: true });
    const record = {
      ...metadata,
      deliveryId,
      status: "queued",
      receivedAt: new Date().toISOString(),
    };
    try {
      await writeFile(this.#path(deliveryId), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
      return { claimed: true, record };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { claimed: false, record: await this.get(deliveryId) };
    }
  }

  async mark(deliveryId, status, details = {}) {
    const current = await this.get(deliveryId);
    if (!current) throw new Error(`Unknown webhook delivery '${deliveryId}'.`);
    const record = { ...current, ...details, status, updatedAt: new Date().toISOString() };
    const target = this.#path(deliveryId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
    await rename(temporary, target);
    return record;
  }

  async get(deliveryId) {
    const content = await readFile(this.#path(deliveryId), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return content ? JSON.parse(content) : undefined;
  }

  #path(deliveryId) {
    const digest = createHash("sha256").update(String(deliveryId)).digest("hex");
    return join(this.directory, `${digest}.json`);
  }
}
