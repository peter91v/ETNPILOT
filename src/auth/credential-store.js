import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where a login lives: one small file in the person's own configuration
// directory, outside every repository, readable by its owner only. A project
// never holds it, so it cannot be committed, and a worktree does not copy it.
//
// An entry is addressed by the secret's name ('anthropic.apiKey',
// 'github.token'), the same names the project's secrets section already uses,
// so a stored login answers exactly the question the environment would have.
// The environment still wins when it holds a value: a variable somebody set is
// a decision, a stored login is a convenience.

const FILE_VERSION = 1;
const REFRESH_MARGIN_MS = 60_000;

export function credentialStorePath(env = process.env) {
  if (env.ETNPILOT_HOME) return join(env.ETNPILOT_HOME, "credentials.json");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "etnpilot", "credentials.json");
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, ".config", "etnpilot", "credentials.json") : undefined;
}

export class CredentialStore {
  constructor({ path, now = () => Date.now(), refresher } = {}) {
    if (!path) throw new TypeError("A credential store needs a file path.");
    this.path = path;
    this.now = now;
    // (entry) => Promise<entry | undefined>: renews an expiring login. Injected
    // so that this file knows nothing of any provider's endpoints.
    this.refresher = refresher;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.credentials && typeof parsed.credentials === "object") {
        return { version: FILE_VERSION, credentials: parsed.credentials, apps: parsed.apps ?? {} };
      }
    } catch {
      // A missing or unreadable file is an empty store.
    }
    return { version: FILE_VERSION, credentials: {}, apps: {} };
  }

  async write(data) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, this.path);
  }

  // The value for a secret name, renewed first if it is about to expire.
  async get(name) {
    const data = await this.read();
    const entry = data.credentials[name];
    if (!entry || typeof entry.value !== "string" || entry.value === "") return undefined;
    if (entry.expiresAt && this.refresher && entry.expiresAt - this.now() < REFRESH_MARGIN_MS) {
      const renewed = await this.refresher(entry).catch(() => undefined);
      if (renewed?.value) {
        data.credentials[name] = renewed;
        await this.write(data).catch(() => {});
        return renewed.value;
      }
      // Could not renew: an expired value is worse than none, a still-valid one is fine.
      if (entry.expiresAt <= this.now()) return undefined;
    }
    return entry.value;
  }

  async save(name, entry) {
    const data = await this.read();
    data.credentials[name] = { ...entry, savedAt: new Date(this.now()).toISOString() };
    await this.write(data);
  }

  async remove(name) {
    const data = await this.read();
    const had = name in data.credentials;
    delete data.credentials[name];
    if (had) {
      if (Object.keys(data.credentials).length === 0 && Object.keys(data.apps).length === 0) await rm(this.path, { force: true });
      else await this.write(data);
    }
    return had;
  }

  // What may be shown: who, how, since when. Never the value or a refresh token.
  async describe(name) {
    const entry = (await this.read()).credentials[name];
    if (!entry) return undefined;
    return {
      kind: entry.kind ?? "key",
      account: entry.account,
      host: entry.host,
      savedAt: entry.savedAt,
      expiresAt: entry.expiresAt,
      verified: entry.verified !== false,
    };
  }

  // The OAuth application a person registered for a service, remembered so the
  // client id is typed once.
  async app(service) {
    return (await this.read()).apps[service];
  }

  async saveApp(service, app) {
    const data = await this.read();
    data.apps[service] = { ...data.apps[service], ...app };
    await this.write(data);
  }
}

export function openCredentialStore({ env = process.env, refresher, now } = {}) {
  const path = credentialStorePath(env);
  return path ? new CredentialStore({ path, refresher, now }) : undefined;
}
