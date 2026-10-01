// The four places a person signs in to. Each one is addressed by the secret
// name the project already uses for it, so a stored login is found by the same
// code that would have read the environment variable.
//
// What each can do is stated plainly, because only two of them offer a real
// browser sign-in: GitHub and GitLab have OAuth device flows for tools like
// this one. Anthropic and OpenAI sell API access by key, and neither lets a
// third-party tool sign in on a person's behalf, so for them 'login' means
// "enter the key once, check it, keep it safely".
export const SERVICES = Object.freeze({
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    secret: "anthropic.apiKey",
    env: "ANTHROPIC_API_KEY",
    method: "key",
    keyHelp: "Create a key at console.anthropic.com → API keys.",
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    secret: "openai.apiKey",
    env: "OPENAI_API_KEY",
    method: "key",
    keyHelp: "Create a key at platform.openai.com → API keys.",
    baseUrl: "https://api.openai.com/v1",
  },
  github: {
    id: "github",
    label: "GitHub",
    secret: "github.token",
    env: "ETNPILOT_GITHUB_TOKEN",
    method: "device",
    scope: "read:user",
    host: "https://github.com",
    apiBase: "https://api.github.com",
    keyHelp: "A personal access token from github.com/settings/tokens works too.",
    appHelp: "Register an OAuth App at github.com/settings/developers, tick 'Enable Device Flow', and pass its client id with --client-id.",
  },
  gitlab: {
    id: "gitlab",
    label: "GitLab",
    secret: "gitlab.apiToken",
    env: "ETNPILOT_GITLAB_TOKEN",
    method: "device",
    scope: "api",
    host: "https://gitlab.com",
    keyHelp: "A personal access token (scope 'api') from your profile → Access tokens works too.",
    appHelp: "Create an application in GitLab (Preferences → Applications) with scope 'api', not confidential, and pass its id with --client-id. The device flow needs GitLab 17.9 or newer.",
  },
});

export const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));

export function serviceFor(id) {
  const service = SERVICES[String(id ?? "").toLowerCase()];
  if (!service) throw new Error(`Unknown service '${id}'. Choose one of: ${SERVICE_IDS.join(", ")}.`);
  return service;
}

export function serviceForSecret(secretName) {
  return Object.values(SERVICES).find((service) => service.secret === secretName);
}
