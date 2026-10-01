// @ts-check
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
    // Where a stored credential may be sent. A project's configuration names
    // the address a provider talks to, and a repository someone else wrote
    // must not be able to point a stored key at a server of its own.
    hosts: ["api.anthropic.com"],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    secret: "openai.apiKey",
    env: "OPENAI_API_KEY",
    method: "key",
    keyHelp: "Create a key at platform.openai.com → API keys.",
    baseUrl: "https://api.openai.com/v1",
    hosts: ["api.openai.com"],
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
    hosts: ["github.com", "api.github.com", "models.github.ai"],
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
    // The host a person signed in to is added when the login is stored.
    hosts: [],
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

// Whether a stored credential may be sent to this address. Only https, and
// only to a host the credential was issued for (or one its owner added).
export function hostAllowed(secretName, entry, baseUrl) {
  const service = serviceForSecret(secretName);
  if (!service) return { ok: false, reason: `'${secretName}' is not a login ETNPilot manages.` };
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: `'${baseUrl}' is not an address.` };
  }
  const allowed = new Set([...(entry?.hosts ?? service.hosts), ...(entry?.allowHosts ?? [])].map((host) => host.toLowerCase()));
  if (entry?.host) {
    try { allowed.add(new URL(entry.host).hostname.toLowerCase()); } catch { /* an entry without a usable host adds none */ }
  }
  const host = url.hostname.toLowerCase();
  if (!allowed.has(host)) {
    return { ok: false, reason: `the stored ${service.label} login is only used with ${[...allowed].join(", ") || "its own host"}, and this address is ${host}. If that is right, run 'etnpilot login ${service.id} --allow-host ${host}'.` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `the stored ${service.label} login is only sent over https, and this address is ${url.protocol}//${host}.` };
  }
  return { ok: true };
}

// The address of a GitLab (or other self-hosted) sign-in, as given by a person
// or a page. Anything the server will contact on request is checked first: a
// web address without credentials in it, https unless the host is on a private
// network, and never the cloud metadata ranges.
export function normalizeAuthHost(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`'${value}' is not a web address (expected something like https://gitlab.example.com).`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The address must start with https:// (or http:// on a private network).");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password.");
  const host = url.hostname.toLowerCase();
  if (/^169\.254\./.test(host) || host.startsWith("[fe80:") || host === "metadata.google.internal" || host === "[fd00:ec2::254]") {
    throw new Error("That address is a link-local or cloud-metadata address, not a sign-in server.");
  }
  const privateHost = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "localhost" || !host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host === "[::1]";
  if (url.protocol === "http:" && !privateHost) throw new Error("A sign-in over plain http is only accepted on a private network. Use https://.");
  return url.origin;
}
