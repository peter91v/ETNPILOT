import { createCopilotProvider } from "./copilot.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

const BUILTIN_FACTORIES = {
  "github-copilot": (name, config, context) => createCopilotProvider({
    ...config,
    name,
    workingDirectory: context.workingDirectory,
    gitHubToken: config.gitHubToken ?? context.env.ETNPILOT_GITHUB_TOKEN,
  }),
  "openai-compatible": (name, config, context) => createOpenAICompatibleProvider({
    ...config,
    name,
    apiKey: config.apiKey ?? context.env.ETNPILOT_PROVIDER_API_KEY,
  }),
};

export function registerConfiguredProviders(harness, providers = {}, context = {}) {
  const factories = { ...BUILTIN_FACTORIES, ...(context.factories ?? {}) };
  for (const [name, config] of Object.entries(providers)) {
    if (harness.providers.has(name)) continue;
    const factory = factories[config.type];
    if (!factory) throw new Error(`Unknown provider type '${config.type}' for '${name}'.`);
    harness.registerProvider(factory(name, config, context));
  }
  return harness.providers.list();
}
