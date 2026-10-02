// @ts-check
import { join, resolve } from "node:path";
import { credentialHelperInstalled, installCredentialHelper } from "../auth/git-credential.js";
import { authStatus, saveKey } from "../auth/login.js";
import { normalizeAuthHost } from "../auth/services.js";
import { loadConfig } from "../config/load.js";
import { setSetting } from "../config/settings.js";
import { git } from "../git/command.js";

// The first-time setup as a few questions with answers that can be checked:
// which provider runs by default, and where the work is published. The terminal
// wizard ('etnpilot init') and the web page ask the same questions of this
// module, so neither knows more than the other about what is ready.

// What each provider of the starter project needs before it can answer.
const PROVIDER_LOGINS = Object.freeze({
  "github-copilot": { service: "github", note: "a GitHub Copilot subscription; the Copilot library has no build for Android" },
  anthropic: { service: "anthropic", note: "an Anthropic API key" },
  openai: { service: "openai", note: "an OpenAI API key" },
  "github-models": { service: "github", note: "a GitHub token with the Models permission" },
});

const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/i;

export function isPlaceholderAddress(address) {
  try {
    return PLACEHOLDER_HOST.test(new URL(address).hostname);
  } catch {
    return true;
  }
}

async function readConfig(root) {
  try {
    return await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  } catch {
    return undefined;
  }
}

// Which providers the project has, which one is the default, and for each
// whether its login is there. Never reads a key's value.
export async function providerChoices({ root = ".", env = process.env } = /** @type {any} */ ({})) {
  const config = await readConfig(resolve(root));
  const logins = new Map((await authStatus({ env })).map((entry) => [entry.id, entry]));
  const options = Object.keys(config?.providers ?? {}).map((id) => {
    const needs = PROVIDER_LOGINS[id];
    const login = needs ? logins.get(needs.service) : undefined;
    return {
      id,
      type: config.providers[id].type,
      service: needs?.service,
      method: login?.method,
      note: needs?.note ?? "",
      // A provider with no known login (a local server, a custom one) is not
      // something this module can say is missing a key.
      ready: needs ? Boolean(login?.connected) : true,
      unavailable: id === "github-copilot" && process.platform === "android",
    };
  });
  return { current: config?.defaultProvider, options };
}

// The person's own choice, kept in their own settings (never committed).
export async function chooseDefaultProvider(id, { root = ".", env = process.env } = /** @type {any} */ ({})) {
  const { options } = await providerChoices({ root, env });
  if (!options.some((option) => option.id === id)) {
    throw new Error(`The project has no provider '${id}'. Choose one of: ${options.map((option) => option.id).join(", ")}.`);
  }
  await setSetting("defaultProvider", id, { root: resolve(root), env, scope: "local" });
  return { id };
}

// 'group/project', from what a person is likely to paste: the path, the web
// address of the project, or its clone address.
export function parseProjectPath(value, baseUrl) {
  let text = String(value ?? "").trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    if (baseUrl && url.origin !== new URL(baseUrl).origin) throw new Error(`That address is on ${url.host}, but the GitLab address is ${new URL(baseUrl).host}.`);
    text = url.pathname;
  }
  text = text.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(text)) {
    throw new Error(`'${value}' is not a project path. Use the form group/project (for a subgroup: group/subgroup/project).`);
  }
  return text;
}

// What the GitLab step starts from: what is already set, so the question can
// offer it as the answer.
export async function gitlabState({ root = ".", env = process.env } = /** @type {any} */ ({})) {
  const projectRoot = resolve(root);
  const config = await readConfig(projectRoot);
  const baseUrl = config?.git?.baseUrl && !isPlaceholderAddress(config.git.baseUrl) ? config.git.baseUrl : undefined;
  const login = (await authStatus({ env })).find((entry) => entry.id === "gitlab");
  const inside = await git(["rev-parse", "--show-toplevel"], { cwd: projectRoot }).then(() => true, () => false);
  return {
    baseUrl,
    project: config?.git?.project,
    remote: config?.git?.remote ?? "gitlab",
    connected: Boolean(login?.connected),
    account: login?.stored?.account,
    checkout: inside,
    helper: baseUrl && inside ? await credentialHelperInstalled(projectRoot, baseUrl) : false,
  };
}

// Stores the login, tells the project where it publishes, makes sure the git
// remote exists, and lets plain 'git push' use the login. Every step is the one
// the person would otherwise take by hand; the result lists what was done.
export async function connectGitLab({ root = ".", env = process.env, fetchImpl, host, project, user, token, remote } = /** @type {any} */ ({})) {
  const projectRoot = resolve(root);
  const address = normalizeAuthHost(host);
  const path = parseProjectPath(project, address);
  const name = remote || "gitlab";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`'${name}' is not a usable git remote name.`);
  const saved = token
    ? await saveKey("gitlab", token, { env, fetchImpl, host: address, account: user })
    : undefined;
  const done = [];
  if (saved) done.push(`Stored the GitLab token${saved.account ? ` for ${saved.account}` : ""}${saved.verified ? "" : " (not verified)"}.`);
  await setSetting("git.baseUrl", address, { root: projectRoot, env, scope: "local" });
  await setSetting("git.project", path, { root: projectRoot, env, scope: "local" });
  await setSetting("git.remote", name, { root: projectRoot, env, scope: "local" });
  done.push(`Publishing goes to ${address}/${path} through the git remote '${name}' (your own settings, not committed).`);
  const inside = await git(["rev-parse", "--show-toplevel"], { cwd: projectRoot }).then(() => true, () => false);
  if (inside) {
    const url = `${address}/${path}.git`;
    const existing = await git(["remote", "get-url", name], { cwd: projectRoot }).then((result) => result.stdout, () => undefined);
    if (!existing) {
      await git(["remote", "add", name, url], { cwd: projectRoot });
      done.push(`Added the git remote '${name}': ${url}.`);
    } else if (existing !== url) {
      done.push(`The git remote '${name}' already points to ${existing}; it was left alone.`);
    }
    await installCredentialHelper(projectRoot, address);
    done.push("git in this repository uses the stored login for that host, so 'git push' asks for nothing.");
  } else {
    done.push("This directory is not a git repository yet; run 'git init' and sign in again to let git use the login.");
  }
  return { done, account: saved?.account, verified: saved?.verified };
}
