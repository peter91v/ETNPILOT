import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { copilotSdkAdvice, copilotSdkPlatformSupported } from "../providers/copilot.js";
import { routeFor } from "../providers/router.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { PolicyEngine } from "../policy/engine.js";
import { openProjectState } from "./project-state.js";

// Whether a run could start on this machine, and against which provider.
// It lives here rather than in the CLI because every surface asks the same
// question: 'etnpilot doctor', the checks view, and the first-run screen all
// read this one answer.

export async function diagnose(root) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const checks = {
    node: process.versions.node,
    // node:sqlite backs the durable queue and the approval inbox.
    nodeSupported: major > 22 || (major === 22 && minor >= 13),
    git: await commandExists("git"),
    sqlite: await import("node:sqlite").then(() => true, () => false),
    copilotSdk: await import("@github/copilot-sdk").then(() => true, () => false),
    copilotSdkAvailableForPlatform: copilotSdkPlatformSupported(),
    project: await access(join(root, ".etnpilot", "etnpilot.yaml")).then(() => true, () => false),
  };
  // Whether a run could actually start here. 'ready' that ignores the route
  // says yes on a machine where the configured provider cannot run at all —
  // which is what 'etnpilot run' then reports, one command too late.
  const routing = checks.project ? await diagnoseRoute(root, checks) : undefined;
  return {
    ...checks,
    ...(routing ? { routing } : {}),
    ready: checks.nodeSupported && checks.git && checks.sqlite && (routing ? routing.usable !== null : true),
    hints: [
      checks.nodeSupported ? undefined : "Node.js 22.13 or newer is required for node:sqlite.",
      checks.git ? undefined : "Install git; ETNPilot runs every repository operation through it.",
      checks.copilotSdk ? undefined : copilotSdkAdvice(),
      checks.project ? undefined : "No '.etnpilot/etnpilot.yaml' found. Run 'etnpilot init' first.",
      ...(routing?.hints ?? []),
    ].filter(Boolean),
  };
}

// The provider a run would reach, and whether it can run here. Everything it
// reports is read the same way the run reads it.
async function diagnoseRoute(root, checks) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(() => undefined);
  if (!config) return { error: "The project configuration could not be read.", route: [], usable: null, hints: [] };
  const state = await openProjectState({ root }).catch(() => undefined);
  const described = await state?.agents().catch(() => undefined);
  state?.close?.();
  // The same agent a run would take: 'defaultAgent', or 'orchestrator', which
  // is what the workflow falls back to.
  const name = described?.defaultAgent ?? config.defaultAgent ?? "orchestrator";
  const agent = described?.agents?.find((entry) => entry.name === name);
  const { providers } = routeFor(
    { name: name ?? "the default agent", ...(agent?.provider ? { provider: agent.provider } : {}) },
    { rules: config.routing?.rules ?? [], defaults: [...(config.routing?.defaults ?? []), ...(config.defaultProvider ? [config.defaultProvider] : [])] },
  );
  const resolver = createSecretResolver({ root, config, env: process.env });
  const policy = config.policy ? new PolicyEngine(config.policy) : undefined;
  const route = [];
  for (const provider of providers) {
    route.push(await diagnoseProvider(provider, config, resolver, checks, policy));
  }
  const usable = route.find((entry) => entry.usable)?.name ?? null;
  // A way out beats a diagnosis: where the routed provider cannot run but
  // another configured one can, name it and the setting that switches.
  const alternatives = [];
  if (!usable) {
    for (const other of Object.keys(config.providers ?? {})) {
      if (route.some((entry) => entry.name === other)) continue;
      if ((await diagnoseProvider(other, config, resolver, checks, policy)).usable) alternatives.push(other);
    }
  }
  return {
    agent: name,
    route,
    usable,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    hints: usable
      ? []
      : [
        route.length === 0
          ? "No provider is routed: set 'defaultProvider', or name one in the agent manifest."
          : `No routed provider can run here: ${route.map((entry) => `'${entry.name}' ${entry.reason}`).join("; ")}.`,
        ...(alternatives.length > 0
          ? [`Ready to use instead: ${alternatives.map((one) => `'${one}'`).join(", ")}.`
            + ` Switch with 'etnpilot config set defaultProvider ${alternatives[0]}' — that stays local.`]
          : []),
      ],
  };
}

async function diagnoseProvider(name, config, resolver, checks, policy) {
  const configured = config.providers?.[name];
  if (!configured) return { name, usable: false, reason: "is not configured under 'providers'" };
  // Policy first: a denied provider cannot run however well it is configured,
  // and 'policy.**' is stricter-only, so no local file can allow it.
  const decision = policy?.evaluateProvider(name);
  if (decision && decision.allowed === false) {
    return {
      name,
      type: configured.type,
      usable: false,
      reason: "is denied by policy.providers, which only the committed file can change",
    };
  }
  const type = configured.type;
  if (type === "github-copilot") {
    return checks.copilotSdk
      ? { name, type, usable: true }
      : { name, type, usable: false, reason: "needs '@github/copilot-sdk', which is not installed here" };
  }
  if (type === "openai-compatible" || type === "anthropic") {
    const secret = configured.apiKeySecret ?? (type === "anthropic" ? "anthropic.apiKey" : "provider.apiKey");
    const key = configured.apiKey ? { available: true } : await resolver.check(secret);
    if (key.available) return { name, type, usable: true, key: secret };
    // A model server on this machine is the one endpoint that needs no key.
    if (type === "openai-compatible" && isLoopbackUrl(configured.baseUrl)) return { name, type, usable: true };
    return { name, type, usable: false, key: secret, reason: `has no key: ${describeMissingKey(secret, config)}` };
  }
  // A provider type this command does not know about is not a provider that
  // cannot run; saying so would be a guess.
  return { name, type, usable: true, checked: false };
}

function describeMissingKey(secret, config) {
  const reference = config.secrets?.values?.[secret];
  if (reference?.provider === "env") return `set ${reference.key}`;
  if (reference) return `secret '${secret}' is not available from '${reference.provider}'`;
  return `secret '${secret}' is not mapped under 'secrets.values'`;
}

function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function commandExists(commandName) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveResult) => {
    const child = spawn(commandName, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}
