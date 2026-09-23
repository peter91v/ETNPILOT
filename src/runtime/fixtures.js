import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSecrets } from "../core/text-safety.js";

const FIXTURE_VERSION = 1;

// Recording what providers answered turns a run into something that can be
// re-executed offline. Prompts and answers are redacted before they are
// written, because a fixture file is meant to be shareable evidence, not a
// second copy of the project's secrets.
export function createFixtureRecorder({ path, redact = true } = {}) {
  if (!path) throw new TypeError("A fixture recorder requires a path.");
  const exchanges = [];

  return {
    path: resolve(path),
    exchanges,
    wrap(provider) {
      return {
        ...provider,
        async invoke(context) {
          const result = await provider.invoke(context);
          exchanges.push({
            agent: context.agent.name,
            provider: provider.name,
            step: context.metadata?.workflowStep,
            inputHash: hashInput(context.input),
            result: sanitizeResult(result, redact),
          });
          return result;
        },
      };
    },
    async flush() {
      await mkdir(dirname(resolve(path)), { recursive: true });
      await writeFile(resolve(path), `${JSON.stringify({
        version: FIXTURE_VERSION,
        recordedAt: new Date().toISOString(),
        redacted: redact,
        exchanges,
      }, null, 2)}\n`, "utf8");
      return { path: resolve(path), exchanges: exchanges.length };
    },
  };
}

export async function loadFixtures(path) {
  const document = JSON.parse(await readFile(resolve(path), "utf8"));
  if (document?.version !== FIXTURE_VERSION) {
    throw new Error(`Unsupported fixture version: ${document?.version}.`);
  }
  if (!Array.isArray(document.exchanges)) throw new Error("Fixture file contains no exchanges.");
  return document;
}

// Replays recorded answers in the order they were recorded, per agent. A
// changed prompt means the fixture no longer describes this run, which is
// reported rather than quietly replayed.
export function createFixturePlayer(document, { strict = true } = {}) {
  const queues = new Map();
  for (const exchange of document.exchanges) {
    const queue = queues.get(exchange.agent) ?? [];
    queue.push(exchange);
    queues.set(exchange.agent, queue);
  }
  const consumed = [];

  const player = {
    consumed,
    remaining: () => [...queues.values()].reduce((total, queue) => total + queue.length, 0),
    factory: (name) => ({
      name,
      capabilities: ["chat"],
      async invoke(context) {
        const queue = queues.get(context.agent.name);
        if (!queue || queue.length === 0) {
          throw new Error(`No recorded answer left for agent '${context.agent.name}'.`);
        }
        const exchange = queue.shift();
        if (strict && exchange.inputHash !== hashInput(context.input)) {
          throw new Error(
            `Recorded input for agent '${context.agent.name}' does not match this run.`
            + " The fixture is stale; re-record it or replay with strict matching disabled.",
          );
        }
        consumed.push(exchange);
        return exchange.result;
      },
    }),
  };
  return player;
}

// Every configured provider type resolves to the same replaying provider, so
// a recorded run re-executes without reaching any of them.
export function fixtureProviderFactories(document, { types = [], ...options } = {}) {
  const player = createFixturePlayer(document, options);
  return {
    player,
    factories: Object.fromEntries([...new Set(types)].map((type) => [type, player.factory])),
  };
}

function sanitizeResult(result, redact) {
  if (result === null || typeof result !== "object") return redactValue(result, redact);
  const { raw, ...rest } = result;
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, redactValue(value, redact)]));
}

function redactValue(value, redact) {
  if (!redact) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  }
  return value;
}

function hashInput(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 32);
}
