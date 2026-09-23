import { definePlugin } from "etnpilot/plugin";

let runtime;

export default definePlugin({
  apiVersion: 1,
  name: "vault-secret-provider",
  version: "1.0.0",
  capabilities: ["secret.register", "secret.read", "network.fetch"],
  setup(context, options) {
    runtime = createVaultRuntime(context, options);
    context.registerSecretProvider({
      name: runtime.name,
      resolve: (key) => runtime.resolve(key),
    });
  },
  async shutdown() {
    await runtime?.close();
    runtime = undefined;
  },
});

function createVaultRuntime(context, options) {
  const config = normalizeOptions(options);
  let session;

  return Object.freeze({
    name: config.name,
    async resolve(key) {
      const reference = parseReference(key, config.allowedPaths);
      let token = await ensureSession();
      let response = await readSecret(reference.path, token);
      if ([401, 403].includes(response.status)) {
        session = undefined;
        token = await login();
        response = await readSecret(reference.path, token);
      }
      if (response.status === 404) return undefined;
      const payload = parseVaultResponse(response, "read");
      const values = config.engineVersion === 2 ? payload?.data?.data : payload?.data;
      const value = values?.[reference.field];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") throw vaultError("Vault secret field is not a string.", "vault_invalid_value");
      return value;
    },
    async close() {
      const active = session;
      session = undefined;
      if (!active || !config.revokeOnShutdown) return;
      await request("v1/auth/token/revoke-self", {
        method: "POST",
        token: active.token,
        body: {},
      }).catch(() => {});
    },
  });

  async function ensureSession() {
    if (!session) return login();
    if (Date.now() < session.renewAt) return session.token;
    if (session.renewable) {
      try {
        const response = await request("v1/auth/token/renew-self", {
          method: "POST",
          token: session.token,
          body: {},
        });
        const payload = parseVaultResponse(response, "renew");
        session = sessionFromAuth(payload.auth, config.renewBeforeMs, session.token);
        return session.token;
      } catch {
        session = undefined;
      }
    } else {
      session = undefined;
    }
    return login();
  }

  async function login() {
    const jwt = await context.resolveSecret(config.tokenSecret);
    if (typeof jwt !== "string" || jwt.length === 0) {
      throw vaultError("Vault identity token is unavailable.", "vault_identity_unavailable");
    }
    const response = await request(`v1/auth/${encodePath(config.authMount)}/login`, {
      method: "POST",
      body: { role: config.role, jwt },
    });
    const payload = parseVaultResponse(response, "login");
    session = sessionFromAuth(payload.auth, config.renewBeforeMs);
    return session.token;
  }

  function readSecret(path, token) {
    const enginePath = config.engineVersion === 2
      ? `v1/${encodePath(config.engineMount)}/data/${encodePath(path)}`
      : `v1/${encodePath(config.engineMount)}/${encodePath(path)}`;
    return request(enginePath, { method: "GET", token });
  }

  function request(path, { method, token, body }) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["x-vault-token"] = token;
    if (config.namespace) headers["x-vault-namespace"] = config.namespace;
    return context.fetch({
      url: new URL(path, config.address).href,
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

function normalizeOptions(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Vault plugin options must be an object.");
  }
  const name = validName(value.name ?? "vault", "Vault provider name");
  let address;
  try {
    address = new URL(value.address);
  } catch {
    throw new TypeError("Vault address must be an absolute HTTPS URL.");
  }
  if (address.protocol !== "https:" || !address.hostname || address.username || address.password
    || address.search || address.hash) {
    throw new TypeError("Vault address must be a credential-free HTTPS URL.");
  }
  if (!address.pathname.endsWith("/")) address.pathname += "/";
  const auth = value.auth;
  if (!auth || Array.isArray(auth) || typeof auth !== "object") {
    throw new TypeError("Vault auth configuration is required.");
  }
  if ((auth.method ?? "jwt") !== "jwt") throw new TypeError("Vault auth method must be 'jwt'.");
  const tokenSecret = nonEmpty(auth.tokenSecret, "Vault auth tokenSecret");
  const role = nonEmpty(auth.role, "Vault auth role");
  const authMount = validVaultPath(auth.mount ?? "jwt", "Vault auth mount");
  const engine = value.engine ?? {};
  if (!engine || Array.isArray(engine) || typeof engine !== "object") {
    throw new TypeError("Vault engine configuration must be an object.");
  }
  const engineMount = validVaultPath(engine.mount ?? "secret", "Vault engine mount");
  const engineVersion = engine.version ?? 2;
  if (![1, 2].includes(engineVersion)) throw new TypeError("Vault engine version must be 1 or 2.");
  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0) {
    throw new TypeError("Vault allowedPaths must contain at least one path prefix.");
  }
  const allowedPaths = [...new Set(value.allowedPaths.map((path) => validVaultPath(path, "Vault allowed path")))];
  const namespace = value.namespace === undefined ? undefined : nonEmpty(value.namespace, "Vault namespace");
  const renewBeforeSeconds = value.renewBeforeSeconds ?? 30;
  if (!Number.isInteger(renewBeforeSeconds) || renewBeforeSeconds < 0 || renewBeforeSeconds > 3_600) {
    throw new TypeError("Vault renewBeforeSeconds must be an integer from 0 to 3600.");
  }
  return Object.freeze({
    name,
    address: address.href,
    tokenSecret,
    role,
    authMount,
    engineMount,
    engineVersion,
    allowedPaths: Object.freeze(allowedPaths),
    namespace,
    renewBeforeMs: renewBeforeSeconds * 1_000,
    revokeOnShutdown: value.revokeOnShutdown !== false,
  });
}

function parseReference(value, allowedPaths) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 2_048) {
    throw vaultError("Vault secret key is invalid.", "vault_invalid_reference");
  }
  const separator = value.indexOf("#");
  if (separator <= 0 || separator !== value.lastIndexOf("#")) {
    throw vaultError("Vault secret keys must use 'path#field'.", "vault_invalid_reference");
  }
  const path = validVaultPath(value.slice(0, separator), "Vault secret path");
  const field = value.slice(separator + 1);
  if (!field || field.length > 256 || /[\u0000-\u001f]/.test(field)) {
    throw vaultError("Vault secret field is invalid.", "vault_invalid_reference");
  }
  if (!allowedPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw vaultError("Vault secret path is outside the configured allowlist.", "vault_path_denied");
  }
  return { path, field };
}

function parseVaultResponse(response, operation) {
  if (!response || !Number.isInteger(response.status) || typeof response.body !== "string") {
    throw vaultError("Vault returned an invalid response.", "vault_invalid_response");
  }
  if (response.status < 200 || response.status >= 300) {
    throw vaultError(`Vault ${operation} failed.`, `vault_${operation}_failed`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw vaultError("Vault returned invalid JSON.", "vault_invalid_response");
  }
}

function sessionFromAuth(auth, renewBeforeMs, previousToken) {
  const token = auth?.client_token ?? previousToken;
  const leaseSeconds = auth?.lease_duration;
  if (typeof token !== "string" || token.length === 0
    || !Number.isFinite(leaseSeconds) || leaseSeconds < 0) {
    throw vaultError("Vault authentication response is invalid.", "vault_invalid_response");
  }
  const leaseMs = Math.max(1_000, Math.floor(leaseSeconds * 1_000));
  const expiresAt = Date.now() + leaseMs;
  return {
    token,
    renewable: auth?.renewable === true,
    expiresAt,
    renewAt: Math.max(Date.now(), expiresAt - renewBeforeMs),
  };
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function validVaultPath(value, label) {
  const path = nonEmpty(value, label).replace(/^\/+|\/+$/g, "");
  const segments = path.split("/");
  if (!path || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${label} must not contain empty or traversal segments.`);
  }
  return path;
}

function validName(value, label) {
  const name = nonEmpty(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new TypeError(`${label} is invalid.`);
  return name;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function vaultError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
