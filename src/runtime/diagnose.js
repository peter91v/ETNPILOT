import { swallow } from "./swallow.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { copilotSdkAdvice, copilotSdkPlatformSupported } from "../providers/copilot.js";
import { routeFor } from "../providers/router.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { PolicyEngine } from "../policy/engine.js";
import { openProjectState } from "./project-state.js";
import { openCredentialStore } from "../auth/credential-store.js";
import { trustState } from "../trust/trust.js";
import { hostAllowed, serviceForSecret } from "../auth/services.js";

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
  const warnings = checks.project ? await diagnoseWarnings(root) : [];
  return {
    ...checks,
    ...(routing ? { routing } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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

// Things that do not stop a run and are still worth knowing, said once: what
// the receipts can and cannot prove, where commands run, whether the stored
// logins are protected, whether this project was looked at.
async function diagnoseWarnings(root) {
  const warnings = [];
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(swallow("reading the configuration", undefined));
  if (!config) return warnings;
  if (config.receipts?.signing?.enabled !== true) {
    warnings.push("Receipts are not signed. Their hash chain shows accidental edits, but anyone who can write the files can rewrite the whole chain. Enable receipts.signing (see docs/signed-receipts.md) if the receipts are meant as proof.");
  }
  if (config.sandbox?.enabled !== true) {
    warnings.push("Approved commands run directly on this machine; sandbox.enabled is false.");
  }
  warnings.push(...keysSentElsewhere(config));
  const problem = await openCredentialStore({ env: process.env })?.permissionsProblem();
  if (problem) warnings.push(problem);
  const trust = await trustState(root, { env: process.env }).catch(() => undefined);
  if (trust && !trust.trusted) {
    warnings.push(trust.changed
      ? "This project's configuration changed since you trusted it. Run 'etnpilot trust' to look at it again."
      : "This project has not been trusted on this machine yet. Run 'etnpilot trust' to look at what it can do.");
  }
  return warnings;
}

// A key kept in the environment goes wherever the provider's baseUrl points;
// unlike a stored login it is not bound to the vendor's own hosts. That is
// the point of setting a baseUrl, so it is a heads-up, not an error.
function keysSentElsewhere(config) {
  const warnings = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (!provider?.baseUrl || isLoopbackUrl(provider.baseUrl)) continue;
    const secret = provider.apiKeySecret ?? (provider.type === "anthropic" ? "anthropic.apiKey" : provider.type === "openai-compatible" ? "provider.apiKey" : undefined);
    if (!secret || !serviceForSecret(secret)) continue;
    const reference = config.secrets?.values?.[secret];
    if (reference && reference.provider !== "env") continue;
    if (hostAllowed(secret, undefined, provider.baseUrl).ok) continue;
    let host = provider.baseUrl;
    try { host = new URL(provider.baseUrl).hostname; } catch { /* shown as written */ }
    warnings.push(`Provider '${name}' sends the key '${secret}' to ${host}, which is not one of the vendor's own hosts. A key from the environment is not bound to a host, so make sure ${host} is meant to get it.`);
  }
  return warnings;
}

// The provider a run would reach, and whether it can run here. Everything it
// reports is read the same way the run reads it.
async function diagnoseRoute(root, checks) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(swallow("reading the configuration", undefined));
  if (!config) return { error: "The project configuration could not be read.", route: [], usable: null, hints: [] };
  const state = await openProjectState({ root }).catch(swallow("opening project state", undefined));
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
    const key = configured.apiKey ? { available: true } : await resolver.check(secret, { baseUrl: configured.baseUrl ?? (type === "anthropic" ? "https://api.anthropic.com" : undefined) });
    if (key.available) return { name, type, usable: true, key: secret };
    if (key.refused) return { name, type, usable: false, key: secret, reason: `has a stored login that is not used here: ${key.refused}` };
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
