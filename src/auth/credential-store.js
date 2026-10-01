// @ts-check
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostAllowed, serviceForSecret } from "./services.js";

// Where a login lives: one small file in the person's own configuration
// directory, outside every repository, readable by its owner only. A project
// never holds it, so it cannot be committed, and a worktree does not copy it.
//
// An entry is addressed by the secret's name ('anthropic.apiKey',
// 'github.token'), the same names the project's secrets section already uses,
// so a stored login answers exactly the question the environment would have.
// The environment still wins when it holds a value: a variable somebody set is
// a decision, a stored login is a convenience.
//
// The file is plain text with owner-only permissions, like the credentials
// files of most command-line tools; there is no keychain to rely on in Termux.
// What keeps a stored login from being used against its owner is that it is
// bound to the hosts it was issued for (see hostAllowed).

const FILE_VERSION = 1;
const REFRESH_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

export function credentialStorePath(env = process.env) {
  if (env.ETNPILOT_HOME) return join(env.ETNPILOT_HOME, "credentials.json");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "etnpilot", "credentials.json");
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, ".config", "etnpilot", "credentials.json") : undefined;
}

export class CredentialStore {
  constructor({ path, now = () => Date.now(), refresher, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = /** @type {any} */ ({})) {
    if (!path) throw new TypeError("A credential store needs a file path.");
    this.path = path;
    this.now = now;
    // (entry) => Promise<entry | undefined>: renews an expiring login. Injected
    // so that this file knows nothing of any provider's endpoints.
    this.refresher = refresher;
    this.sleep = sleep;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.credentials && typeof parsed.credentials === "object") {
        return { version: FILE_VERSION, credentials: parsed.credentials, apps: parsed.apps ?? {} };
      }
    } catch (error) {
      // A missing file is an empty store. A file that is there and cannot be
      // read or parsed is not: say so rather than act as if nothing was saved.
      if (error.code !== "ENOENT") this.damaged = error.message;
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

  // Reading, changing and writing the file is one step to anyone else using it:
  // the page and the terminal can both renew the same login, and a renewal uses
  // up the refresh token it was given.
  async locked(work) {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const started = Date.now();
    for (;;) {
      try {
        await writeFile(lock, `${process.pid} ${Date.now()}\n`, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const age = await stat(lock).then((details) => Date.now() - details.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await rm(lock, { force: true }); continue; }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error("The stored logins are being changed by another ETNPilot; try again in a moment.");
        await this.sleep(40);
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  // The value for a secret name, renewed first if it is about to expire.
  // 'baseUrl' is where it is about to be sent; a login is only handed to a host
  // it was issued for. Returns { value } or { refused } or undefined.
  async resolve(name, { baseUrl } = /** @type {any} */ ({})) {
    if (!serviceForSecret(name)) return undefined;
    let entry = (await this.read()).credentials[name];
    if (!entry || typeof entry.value !== "string" || entry.value === "") return undefined;
    if (baseUrl !== undefined) {
      const verdict = hostAllowed(name, entry, baseUrl);
      if (!verdict.ok) return { refused: verdict.reason };
    }
    if (entry.expiresAt && entry.expiresAt - this.now() < REFRESH_MARGIN_MS) {
      entry = await this.renew(name, entry);
      if (!entry) return undefined;
    }
    return { value: entry.value };
  }

  async get(name, options) {
    return (await this.resolve(name, options))?.value;
  }

  // Under the lock, and re-read inside it: another process may have renewed
  // already, in which case its result is used and the refresh token is not
  // spent twice. A write that fails after a renewal is an error, not something
  // to swallow: the new refresh token would be lost and the old one is used up.
  async renew(name, seen) {
    if (!this.refresher) return seen.expiresAt > this.now() ? seen : undefined;
    return this.locked(async () => {
      const data = await this.read();
      const current = data.credentials[name];
      if (!current) return undefined;
      if (!current.expiresAt || current.expiresAt - this.now() >= REFRESH_MARGIN_MS) return current;
      let renewed;
      try {
        renewed = await this.refresher(current);
      } catch (error) {
        if (error?.code === "invalid_grant") {
          // The service no longer accepts the refresh token: say that, instead
          // of looking like a login that was never made.
          data.credentials[name] = { ...current, needsSignIn: true, expiredAt: new Date(this.now()).toISOString() };
          await this.write(data);
          return undefined;
        }
        renewed = undefined;
      }
      if (!renewed?.value) return current.expiresAt > this.now() ? current : undefined;
      data.credentials[name] = { ...renewed, needsSignIn: undefined };
      await this.write(data);
      return data.credentials[name];
    });
  }

  async save(name, entry) {
    return this.locked(async () => {
      const data = await this.read();
      data.credentials[name] = { ...entry, savedAt: new Date(this.now()).toISOString() };
      await this.write(data);
    });
  }

  async remove(name) {
    return this.locked(async () => {
      const data = await this.read();
      const had = name in data.credentials;
      delete data.credentials[name];
      if (had) {
        if (Object.keys(data.credentials).length === 0 && Object.keys(data.apps).length === 0) await rm(this.path, { force: true });
        else await this.write(data);
      }
      return had;
    });
  }

  // Adds a host the owner chose to send this login to, such as a proxy.
  async allowHost(name, host) {
    return this.locked(async () => {
      const data = await this.read();
      const entry = data.credentials[name];
      if (!entry) throw new Error("There is no stored login to add a host to. Sign in first.");
      const hosts = new Set([...(entry.allowHosts ?? []), host.toLowerCase()]);
      data.credentials[name] = { ...entry, allowHosts: [...hosts] };
      await this.write(data);
      return [...hosts];
    });
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
      needsSignIn: entry.needsSignIn === true,
      allowHosts: entry.allowHosts ?? [],
    };
  }

  // Whether the file is readable by anyone but its owner, which would make
  // "stored safely" untrue. Not meaningful on Windows.
  async permissionsProblem() {
    if (process.platform === "win32") return undefined;
    const details = await stat(this.path).catch(() => undefined);
    if (!details) return undefined;
    return (details.mode & 0o077) !== 0
      ? `${this.path} can be read by other users (mode ${(details.mode & 0o777).toString(8)}). Run: chmod 600 ${this.path}`
      : undefined;
  }

  // The OAuth application a person registered for a service, remembered so the
  // client id is typed once.
  async app(service) {
    return (await this.read()).apps[service];
  }

  async saveApp(service, app) {
    return this.locked(async () => {
      const data = await this.read();
      data.apps[service] = { ...data.apps[service], ...app };
      await this.write(data);
    });
  }
}

export function openCredentialStore({ env = process.env, refresher, now } = /** @type {any} */ ({})) {
  const path = credentialStorePath(env);
  return path ? new CredentialStore({ path, refresher, now }) : undefined;
}
