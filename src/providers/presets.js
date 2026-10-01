// @ts-check
// Providers that speak the OpenAI chat API, so they need no code of their own,
// only an address, a key and a model. `etnpilot provider add <preset>` writes
// the entry; the model is a starting point, not a promise: 'etnpilot models'
// lists what the account actually has.

export const PRESETS = Object.freeze({
  gemini: {
    label: "Google Gemini (OpenAI-compatible endpoint)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-pro",
    env: "GEMINI_API_KEY",
    tools: true,
  },
  mistral: {
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    env: "MISTRAL_API_KEY",
    tools: true,
  },
  openrouter: {
    label: "OpenRouter (many vendors behind one key)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    env: "OPENROUTER_API_KEY",
    tools: true,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    env: "GROQ_API_KEY",
    tools: true,
  },
  ollama: {
    label: "Ollama on this machine (no key)",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    env: undefined,
    // Whether a local model can call tools depends on the model, so it is left off.
    tools: false,
  },
});

// The configuration a preset adds, as [path, value] pairs for `setSetting`.
// A key goes through a secret that is mapped to an environment variable; the
// mapping and the allow-list entry live in the committed file, because the
// local file is not allowed to widen what a project can read.
export function presetSettings(preset, name = undefined, { project = false } = /** @type {any} */ ({})) {
  const entry = PRESETS[preset];
  if (!entry) throw new Error(`Unknown preset '${preset}'. Presets: ${Object.keys(PRESETS).join(", ")}.`);
  const id = name ?? preset;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`'${id}' is not a usable provider name (letters, digits, - and _).`);
  const secret = `${id}-key`;
  /** @type {Array<[string, any]>} */
  const settings = [[`providers.${id}`, {
    type: "openai-compatible",
    baseUrl: entry.baseUrl,
    model: entry.model,
    ...(entry.env ? { apiKeySecret: secret } : {}),
    ...(entry.tools ? { tools: true } : {}),
  }]];
  if (entry.env && project) settings.push([`secrets.values.${secret}`, { provider: "env", key: entry.env }]);
  return { id, secret, entry, settings };
}
