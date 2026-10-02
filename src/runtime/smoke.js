// @ts-check
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus } from "../auth/login.js";
import { Harness } from "../core/harness.js";
import { GitLabClient } from "../gitlab/client.js";
import { copilotSdkAdvice } from "../providers/copilot.js";
import { chooseProvider, forgeProject } from "../forge/forge.js";
import { registerConfiguredProviders, resolveConfiguredApiKey } from "../providers/register.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { createTelemetry } from "../observability/telemetry.js";
import { meteredInvoke } from "../observability/metered-call.js";
import { randomUUID } from "node:crypto";

// What the test suite cannot say: whether this phone, this key and this model
// do what ETNPilot expects. A handful of tiny real requests, each reporting
// pass or fail with the reason, ending in a block that can be pasted back as it
// is. It spends a few cents at most. It writes nothing to the project except
// what it used, into the usage record, because a check that costs money and
// leaves no trace is a cost nobody can find.

export const SMOKE_STEPS = Object.freeze(["key", "reply", "tools", "stream", "toolstream", "forge", "gitlab"]);
const NOT_FOR_COPILOT = new Set(["tools", "stream", "toolstream"]);
const MARKER = "etnpilot-smoke-7421";

export async function runSmoke(root, { config, env = process.env, provider: wanted, model, skip = [], gitlab = false, fetchImpl, factories, sdkImporter, onStep = () => {} } = /** @type {any} */ ({})) {
  /** @type {{ provider: string | undefined, model: string | undefined, steps: any[], tokens: { input: number, output: number }, usageRecorded?: boolean, usageNote?: string }} */
  const report = { provider: undefined, model, steps: [], tokens: { input: 0, output: 0 } };
  const smokeId = randomUUID().slice(0, 8);
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
  // Every request the check makes is metered into the usage record (when
  // observability is on), so what `etnpilot usage` shows and what the
  // provider's dashboard shows can be set against each other.
  const telemetry = await createTelemetry({ root, config, secretResolver: resolver, ...(fetchImpl ? { fetchImpl } : {}) }).catch((error) => {
    report.usageNote = `Usage could not be recorded: ${error.message}`;
    return undefined;
  });
  report.usageRecorded = Boolean(telemetry);
  const ask = async (provider, input, { tools, emitDelta } = /** @type {any} */ ({})) => meteredInvoke({
    telemetry,
    provider,
    providerName: chosen.name,
    attributes: { "etnpilot.workflow.run_id": `smoke-${smokeId}` },
    context: {
      runId: "smoke",
      agent: { name: "smoke", prompt: "You are a terse test responder.", ...(model ? { model } : {}), tools: tools ?? [] },
      input,
      instructions: [],
      skills: [],
      emitDelta,
      // Only the two read tools are offered, so this never has to say no.
      approve: async () => ({ kind: "approve-once" }),
      signal: AbortSignal.timeout(90_000),
    },
  });
  const account = (result) => {
    report.tokens.input += result.usage?.inputTokens ?? 0;
    report.tokens.output += result.usage?.outputTokens ?? 0;
    return `${result.model ?? model ?? chosen.config.model ?? "?"}${result.api ? ` via ${result.api}` : ""}, ${result.usage?.inputTokens ?? "?"} in / ${result.usage?.outputTokens ?? "?"} out`;
  };

  // The Copilot provider has no API key to resolve: it needs the SDK, and a
  // GitHub login the SDK accepts. The SDK has no switch for tools or streaming
  // that ETNPilot could flip, so those steps do not apply to it.
  const copilotKey = async () => {
    try {
      // @ts-ignore -- an optional dependency: it is not installed everywhere
      await (sdkImporter ?? (() => import("@github/copilot-sdk")))();
    } catch (error) {
      throw Object.assign(new Error(`the GitHub Copilot SDK is not available. ${copilotSdkAdvice()}`), { code: "sdk_unavailable", cause: error });
    }
    const stored = (await authStatus({ env })).find((item) => item.id === "github");
    const login = stored?.source === "environment" || stored?.source === "stored"
      ? `the GitHub token from ${stored.source === "stored" ? "'etnpilot login github'" : stored.environmentVariable}`
      : "the user the Copilot CLI is signed in as";
    return `provider '${chosen.name}' (github-copilot), SDK installed, signed in through ${login}`;
  };

  const steps = {
    key: async () => {
      if (chosen.config.type === "github-copilot") return copilotKey();
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
      const result = await ask(await build({ tools: true, stream: false }), TOOL_PROMPT, { tools: ["read_file", "list_files"] });
      return `${toolCalls(result)} tool call(s), ${account(result)}`;
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
      const result = await ask(await build({ tools: true, stream: true }), TOOL_PROMPT, { tools: ["read_file", "list_files"], emitDelta: (piece) => pieces.push(piece) });
      const calls = toolCalls(result);
      if (pieces.length < 2) throw new Error(`the text arrived in ${pieces.length} piece(s), not as a stream`);
      return `${calls} tool call(s) while streaming ${pieces.length} pieces, ${account(result)}`;
    },
    // Reads only: who the token is, and that the project can be seen. Writing to
    // a project is what scripts/gitlab-smoke.mjs does, on a project made for it.
    gitlab: async () => {
      const git = config?.git;
      if (!git?.baseUrl || !git?.project) throw new Error("'git.baseUrl' and 'git.project' are not set in this project");
      const token = await resolver.get("gitlab.apiToken", { fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" }, baseUrl: git.baseUrl });
      if (!token) {
        throw Object.assign(new Error(resolver.refusals.get("gitlab.apiToken") ?? "no GitLab token resolves"), { code: "missing_gitlab_token" });
      }
      const client = new GitLabClient({ baseUrl: git.baseUrl, token, fetchImpl });
      const me = await client.request("GET", "/user");
      const project = await client.project(git.project);
      return `signed in as ${me.username}, project ${project.path_with_namespace ?? git.project} is visible (default branch ${project.default_branch ?? "?"})`;
    },
    forge: async () => {
      const dry = await forgeProject(root, /** @type {any} */ ({ config, env, dryRun: true }));
      const sent = dry.sent ?? { files: 0, bytes: 0, leftOut: 0 };
      return `digest of ${sent.files} files (${Math.round(sent.bytes / 1024)} KiB), ${sent.leftOut} credential files left out; nothing sent`;
    },
  };

  for (const id of SMOKE_STEPS) {
    if (id === "gitlab" && !gitlab) continue;
    if (skip.includes(id) || (chosen.config.type === "github-copilot" && NOT_FOR_COPILOT.has(id))) { report.steps.push({ id, status: "skip" }); continue; }
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

const TOOL_PROMPT = "Use the read_file tool to read hello.txt, then tell me the exact text inside it.";

// The model called the tool, the tool worked, and the answer used what it read.
// Returns how many calls were made.
function toolCalls(result) {
  const calls = result.toolCalls ?? [];
  if (calls.length === 0) throw new Error("the model answered without calling a tool");
  const failed = calls.find((call) => call.ok === false);
  if (failed) throw new Error(`a tool call failed: ${failed.error ?? failed.name}`);
  if (!String(result.text ?? "").includes(MARKER)) throw new Error(`the answer did not contain the file's text: "${String(result.text ?? "").slice(0, 80)}"`);
  return calls.length;
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
  if (error.code === "sdk_unavailable") return "npm install @github/copilot-sdk (Linux, macOS or Windows)";
  if (error.code === "missing_gitlab_token") return "etnpilot login gitlab";
  if (error.code === "use_responses_api") return "set providers.<name>.api to responses";
  return undefined;
}

export function formatSmoke(report) {
  const lines = [];
  for (const step of report.steps) {
    const mark = step.status === "pass" ? "✓" : step.status === "skip" ? "-" : "✗";
    const time = step.ms !== undefined ? `  ${(step.ms / 1000).toFixed(1)} s` : "";
    lines.push(`${mark} ${step.id.padEnd(11)}${step.status === "skip" ? "skipped" : step.detail ?? ""}${time}`);
    if (step.status === "fail" && step.hint) lines.push(`    → ${step.hint}`);
  }
  const ran = report.steps.filter((step) => step.status !== "skip");
  const passed = ran.filter((step) => step.status === "pass").length;
  lines.push(`${passed}/${ran.length} passed${report.provider ? ` against '${report.provider}'` : ""}; ${report.tokens.input.toLocaleString("en")} tokens in, ${report.tokens.output.toLocaleString("en")} out.`);
  if (report.usageNote) lines.push(report.usageNote);
  else if (report.provider && report.tokens.input + report.tokens.output > 0) {
    lines.push(report.usageRecorded ? "Recorded in the usage report (etnpilot usage)." : "Not recorded: observability is off, so this cost appears only on the provider's dashboard.");
  }
  return lines;
}
