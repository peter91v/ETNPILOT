import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus } from "../auth/login.js";
import { Harness } from "../core/harness.js";
import { chooseProvider, forgeProject } from "../forge/forge.js";
import { registerConfiguredProviders, resolveConfiguredApiKey } from "../providers/register.js";
import { createSecretResolver } from "../secrets/resolver.js";

// What the test suite cannot say: whether this phone, this key and this model
// do what ETNPilot expects. A handful of tiny real requests, each reporting
// pass or fail with the reason, ending in a block that can be pasted back as it
// is. It spends a few cents at most and never writes to the project.

export const SMOKE_STEPS = Object.freeze(["key", "reply", "tools", "stream", "toolstream", "forge"]);
const MARKER = "etnpilot-smoke-7421";

export async function runSmoke(root, { config, env = process.env, provider: wanted, model, skip = [], fetchImpl, factories, onStep = () => {} } = {}) {
  const report = { provider: undefined, model, steps: [], tokens: { input: 0, output: 0 } };
  const chosen = wanted
    ? (config?.providers?.[wanted] ? { name: wanted, config: config.providers[wanted] } : undefined)
    : await chooseProvider(config, root, env);
  if (!chosen) {
    // A key can exist and still be refused for the address this project gives
    // the provider; that is the useful thing to say, not "no key".
    const refusals = [];
    if (!wanted) {
      const resolver = createSecretResolver({ root, config, env });
      for (const entry of Object.values(config?.providers ?? {})) {
        if (!["anthropic", "openai-compatible"].includes(entry?.type)) continue;
        await resolveConfiguredApiKey(entry.type, entry, { secretResolver: resolver, env }).catch(() => undefined);
      }
      refusals.push(...new Set(resolver.refusals.values()));
    }
    report.steps.push({
      id: "key", status: "fail",
      detail: wanted
        ? `No provider named '${wanted}' in this project.`
        : refusals.length > 0
          ? `A stored login exists but was not used: ${refusals[0]}`
          : "No configured provider has a key. Sign in with 'etnpilot login openai' or 'etnpilot login anthropic'.",
    });
    return report;
  }
  report.provider = chosen.name;
  const resolver = createSecretResolver({ root, config, env });
  const scratch = await mkdtemp(join(tmpdir(), "etnpilot-smoke-"));
  await writeFile(join(scratch, "hello.txt"), `${MARKER}\n`);

  // A provider instance per step, because 'tools' and 'stream' are settings of
  // the instance, and the project's own entry is what is being tested.
  const build = async (overrides) => {
    const harness = new Harness({});
    await registerConfiguredProviders(harness, {
      smoke: { ...chosen.config, ...overrides, ...(fetchImpl ? { fetchImpl } : {}) },
    }, { workingDirectory: scratch, env, secretResolver: resolver, ...(factories ? { factories } : {}) });
    return harness.providers.get("smoke");
  };
  const ask = async (provider, input, { tools, emitDelta } = {}) => provider.invoke({
    runId: "smoke",
    agent: { name: "smoke", prompt: "You are a terse test responder.", ...(model ? { model } : {}), tools: tools ?? [] },
    input,
    instructions: [],
    skills: [],
    emitDelta,
    // Only the two read tools are offered, so this never has to say no.
    approve: async () => ({ kind: "approve-once" }),
    signal: AbortSignal.timeout(90_000),
  });
  const account = (result) => {
    report.tokens.input += result.usage?.inputTokens ?? 0;
    report.tokens.output += result.usage?.outputTokens ?? 0;
    return `${result.model ?? model ?? chosen.config.model ?? "?"}${result.api ? ` via ${result.api}` : ""}, ${result.usage?.inputTokens ?? "?"} in / ${result.usage?.outputTokens ?? "?"} out`;
  };

  const steps = {
    key: async () => {
      const key = await resolveConfiguredApiKey(chosen.config.type, chosen.config, { secretResolver: resolver, env });
      if (!key) {
        const refused = resolver.refusals.get(chosen.config.apiKeySecret ?? (chosen.config.type === "anthropic" ? "anthropic.apiKey" : "provider.apiKey"));
        throw Object.assign(new Error(refused ? `a stored login exists but was not used: ${refused}` : "no key resolves for this provider"), { code: "missing_api_key" });
      }
      const service = serviceOf(chosen.config);
      const entry = service ? (await authStatus({ env })).find((item) => item.id === service) : undefined;
      const from = entry?.source === "environment" ? `from ${entry.environmentVariable}` : entry?.source === "stored" ? `stored login${entry.stored?.account ? ` (${entry.stored.account})` : ""}` : "resolved";
      return `provider '${chosen.name}' (${chosen.config.type}${chosen.config.model ? `, ${chosen.config.model}` : ""}), key ${from}`;
    },
    reply: async () => {
      const result = await ask(await build({ tools: false, stream: false }), "Reply with exactly one word: pong");
      if (!/pong/i.test(result.text ?? "")) throw new Error(`unexpected answer: "${String(result.text ?? "").slice(0, 80)}"`);
      return account(result);
    },
    tools: async () => {
      const result = await ask(await build({ tools: true, stream: false }), "Use the read_file tool to read hello.txt, then tell me the exact text inside it.", { tools: ["read_file", "list_files"] });
      if ((result.toolCalls ?? []).length === 0) throw new Error("the model answered without calling a tool");
      const failed = result.toolCalls.find((call) => call.ok === false);
      if (failed) throw new Error(`a tool call failed: ${failed.error ?? failed.name}`);
      if (!String(result.text ?? "").includes(MARKER)) throw new Error(`the answer did not contain the file's text: "${String(result.text ?? "").slice(0, 80)}"`);
      return `${result.toolCalls.length} tool call(s), ${account(result)}`;
    },
    stream: async () => {
      const pieces = [];
      const result = await ask(await build({ tools: false, stream: true }), "Count from 1 to 12, separated by spaces, and write nothing else.", { emitDelta: (piece) => pieces.push(piece) });
      if (pieces.length < 2) throw new Error(`the text arrived in ${pieces.length} piece(s), not as a stream`);
      if (!/\b12\b/.test(result.text ?? "")) throw new Error(`unexpected answer: "${String(result.text ?? "").slice(0, 80)}"`);
      return `${pieces.length} pieces, ${account(result)}`;
    },
    // The combination that matters in daily use: text arriving in pieces while
    // a tool is called, on whichever API the model needs. Alone, neither the
    // tool step (no stream) nor the stream step (no tools) reaches it.
    toolstream: async () => {
      const pieces = [];
      const result = await ask(await build({ tools: true, stream: true }), "Use the read_file tool to read hello.txt, then tell me the exact text inside it.", { tools: ["read_file", "list_files"], emitDelta: (piece) => pieces.push(piece) });
      if ((result.toolCalls ?? []).length === 0) throw new Error("the model answered without calling a tool");
      const failed = result.toolCalls.find((call) => call.ok === false);
      if (failed) throw new Error(`a tool call failed: ${failed.error ?? failed.name}`);
      if (!String(result.text ?? "").includes(MARKER)) throw new Error(`the answer did not contain the file's text: "${String(result.text ?? "").slice(0, 80)}"`);
      if (pieces.length < 2) throw new Error(`the text arrived in ${pieces.length} piece(s), not as a stream`);
      return `${result.toolCalls.length} tool call(s) while streaming ${pieces.length} pieces, ${account(result)}`;
    },
    forge: async () => {
      const dry = await forgeProject(root, { config, env, dryRun: true });
      return `digest of ${dry.sent.files} files (${Math.round(dry.sent.bytes / 1024)} KiB), ${dry.sent.leftOut} credential files left out; nothing sent`;
    },
  };

  for (const id of SMOKE_STEPS) {
    if (skip.includes(id)) { report.steps.push({ id, status: "skip" }); continue; }
    const started = Date.now();
    onStep(id);
    try {
      const detail = await steps[id]();
      report.steps.push({ id, status: "pass", detail, ms: Date.now() - started });
    } catch (error) {
      report.steps.push({ id, status: "fail", detail: error.message, code: error.code, hint: hint(error, chosen), ms: Date.now() - started });
      // Without a key nothing after it can work, and each would fail the same way.
      if (id === "key") break;
    }
  }
  return report;
}

function serviceOf(entry) {
  if (entry.type === "anthropic") return "anthropic";
  if (entry.type === "openai-compatible" && /(^|\/\/)api\.openai\.com(\/|$)/.test(entry.baseUrl ?? "")) return "openai";
  return undefined;
}

function hint(error, chosen) {
  const service = serviceOf(chosen.config);
  if (error.code === "missing_api_key" && service) return `etnpilot login ${service}`;
  if (error.code === "http_401" || error.code === "http_403") return service ? `the key was refused; sign in again with 'etnpilot login ${service}'` : "the key was refused";
  if (error.code === "use_responses_api") return "set providers.<name>.api to responses";
  return undefined;
}

export function formatSmoke(report) {
  const lines = [];
  for (const step of report.steps) {
    const mark = step.status === "pass" ? "✓" : step.status === "skip" ? "-" : "✗";
    const time = step.ms !== undefined ? `  ${(step.ms / 1000).toFixed(1)} s` : "";
    lines.push(`${mark} ${step.id.padEnd(7)}${step.status === "skip" ? "skipped" : step.detail ?? ""}${time}`);
    if (step.status === "fail" && step.hint) lines.push(`    → ${step.hint}`);
  }
  const ran = report.steps.filter((step) => step.status !== "skip");
  const passed = ran.filter((step) => step.status === "pass").length;
  lines.push(`${passed}/${ran.length} passed${report.provider ? ` against '${report.provider}'` : ""}; ${report.tokens.input.toLocaleString("en")} tokens in, ${report.tokens.output.toLocaleString("en")} out.`);
  return lines;
}
