import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineSecretProvider } from "./provider.js";

export function createEnvironmentSecretProvider(name, config = {}, { env = process.env } = {}) {
  const allowed = config.allow === undefined ? undefined : new Set(validateAllowedNames(config.allow, name));
  return defineSecretProvider({
    apiVersion: 1,
    name,
    type: "env",
    async resolve(key) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Environment secret keys must be uppercase names.");
      if (allowed && !allowed.has(key)) throw new Error("Environment secret key is not allowed by provider policy.");
      return env[key];
    },
  });
}

export function createFileSecretProvider(name, config = {}, { root = process.cwd() } = {}) {
  if (!config.root) throw new TypeError(`File secret provider '${name}' requires root.`);
  const providerRoot = resolve(root, config.root);
  const requireOwnerOnly = config.requireOwnerOnly !== false;
  const maxBytes = config.maxBytes ?? 65_536;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`File secret provider '${name}' maxBytes must be a positive integer.`);
  }
  return defineSecretProvider({
    apiVersion: 1,
    name,
    type: "file",
    async resolve(key) {
      validateRelativeSecretKey(key);
      const canonicalRoot = await realpath(providerRoot);
      const canonicalTarget = await realpath(resolve(providerRoot, key));
      const pathFromRoot = relative(canonicalRoot, canonicalTarget);
      if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
        throw new Error("Secret file is outside the configured provider root.");
      }
      const details = await stat(canonicalTarget);
      if (!details.isFile()) throw new Error("Secret target is not a regular file.");
      if (details.size > maxBytes) throw new Error("Secret file exceeds the configured size limit.");
      if (requireOwnerOnly && process.platform !== "win32" && (details.mode & 0o077) !== 0) {
        throw new Error("Secret file must not be accessible by group or other users.");
      }
      const value = await readFile(canonicalTarget);
      if (value.length > maxBytes) throw new Error("Secret file exceeds the configured size limit.");
      return value.toString("utf8").replace(/\r?\n$/, "");
    },
  });
}

export const BUILTIN_SECRET_PROVIDER_FACTORIES = Object.freeze({
  env: createEnvironmentSecretProvider,
  file: createFileSecretProvider,
});

function validateAllowedNames(values, providerName) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value))) {
    throw new TypeError(`Secret provider '${providerName}' allow must contain uppercase environment names.`);
  }
  return values;
}

function validateRelativeSecretKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.includes("\0") || isAbsolute(key)) {
    throw new Error("Secret file key must be a non-empty relative path.");
  }
  if (key.split(/[\\/]/).includes("..")) throw new Error("Secret file key may not traverse parent directories.");
}
