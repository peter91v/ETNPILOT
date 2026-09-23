import { createCopilotProvider } from "./copilot.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

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
  "openai-compatible": async (name, config, context) => createOpenAICompatibleProvider({
    ...config,
    name,
    apiKey: config.apiKey ?? await resolveProviderSecret({
      resolver: context.secretResolver,
      name: config.apiKeySecret ?? "provider.apiKey",
      fallbackKey: "ETNPILOT_PROVIDER_API_KEY",
      required: Boolean(config.apiKeySecret),
    }),
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

async function resolveProviderSecret({ resolver, name, fallbackKey, required }) {
  if (!resolver) return undefined;
  return resolver.get(name, {
    fallback: { provider: "env", key: fallbackKey },
    required,
  });
}
