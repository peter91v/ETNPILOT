import { createAnthropicProvider } from "./anthropic.js";
import { createCopilotProvider } from "./copilot.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { createScriptedProvider } from "./scripted.js";

const BUILTIN_FACTORIES = {
  "github-copilot": async (name, config, context) => createCopilotProvider({
    ...config,
    name,
    workingDirectory: context.workingDirectory,
    mcpServers: context.mcpServers,
    readOnlyMcpTools: context.readOnlyMcpTools,
    gitHubToken: config.gitHubToken ?? await resolveProviderSecret({
      resolver: context.secretResolver,
      name: config.tokenSecret ?? "github.token",
      fallbackKey: "ETNPILOT_GITHUB_TOKEN",
      required: Boolean(config.tokenSecret),
    }),
  }),
  anthropic: async (name, config, context) => createAnthropicProvider({
    ...config,
    name,
    apiKeySource: describeApiKeySource(config, context, "anthropic.apiKey", "ANTHROPIC_API_KEY"),
    workingDirectory: config.workingDirectory ?? context.workingDirectory,
    sandbox: context.sandbox,
    apiKey: config.apiKey ?? await resolveProviderSecret({
      resolver: context.secretResolver,
      name: config.apiKeySecret ?? "anthropic.apiKey",
      fallbackKey: describeApiKeySource(config, context, "anthropic.apiKey", "ANTHROPIC_API_KEY").env,
      // Not required here: a project may configure several providers and use
      // one of them. A key that is missing is reported by the provider that
      // needs it, when it is used, and not by failing every run that does not.
      required: false,
    }),
  }),
  "openai-compatible": async (name, config, context) => createOpenAICompatibleProvider({
    ...config,
    name,
    apiKeySource: describeApiKeySource(config, context, "provider.apiKey", "ETNPILOT_PROVIDER_API_KEY"),
    workingDirectory: config.workingDirectory ?? context.workingDirectory,
    sandbox: context.sandbox,
    apiKey: config.apiKey ?? await resolveProviderSecret({
      resolver: context.secretResolver,
      name: config.apiKeySecret ?? "provider.apiKey",
      fallbackKey: describeApiKeySource(config, context, "provider.apiKey", "ETNPILOT_PROVIDER_API_KEY").env,
      // See above: a provider that is configured but not used must not fail
      // the run. A local model server needs no key at all.
      required: false,
    }),
  }),
  scripted: async (name, config, context) => createScriptedProvider({
    ...config,
    name,
    workingDirectory: config.workingDirectory ?? context.workingDirectory,
    sandbox: context.sandbox,
  }),
};

export async function registerConfiguredProviders(harness, providers = {}, context = {}) {
  const factories = { ...BUILTIN_FACTORIES, ...(context.factories ?? {}) };
  for (const [name, config] of Object.entries(providers)) {
    if (harness.providers.has(name)) continue;
    const factory = factories[config.type];
    if (!factory) throw new Error(`Unknown provider type '${config.type}' for '${name}'.`);
    harness.registerProvider(await factory(name, config, context));
  }
  return harness.providers.list();
}

// A message about a missing key is only useful if it names the variable this
// provider reads. That is the secret's own mapping where one exists, and the
// adapter's fallback where the project named no secret of its own.
//
// A secret the project *did* name but never mapped gets no fallback: reading
// the adapter's generic variable instead would take the key from somewhere
// nobody asked for, and report the wrong name when it is missing.
function describeApiKeySource(config, context, defaultSecret, fallbackKey) {
  const secret = config.apiKeySecret ?? defaultSecret;
  const mapped = context.secretResolver?.values?.[secret];
  if (mapped) return { secret, env: mapped.provider === "env" ? mapped.key : undefined, mapped: true };
  return { secret, env: config.apiKeySecret ? undefined : fallbackKey, mapped: false };
}

async function resolveProviderSecret({ resolver, name, fallbackKey, required }) {
  if (!resolver) return undefined;
  return resolver.get(name, {
    ...(fallbackKey ? { fallback: { provider: "env", key: fallbackKey } } : {}),
    required,
  });
}
