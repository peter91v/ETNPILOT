import { builtinModules } from "node:module";

const SAFE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "console", "crypto", "events",
  "path", "path/posix", "path/win32", "perf_hooks", "querystring", "stream",
  "stream/consumers", "stream/promises", "stream/web", "string_decoder", "timers",
  "timers/promises", "url", "util", "util/types", "zlib",
]);
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

let sdkUrl;

export function initialize(data) {
  sdkUrl = data?.sdkUrl;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "etnpilot" || specifier === "etnpilot/plugin") {
    return { url: sdkUrl, shortCircuit: true };
  }
  const builtin = specifier.replace(/^node:/, "");
  if (specifier.startsWith("node:") || BUILTINS.has(builtin)) {
    if (!SAFE_BUILTINS.has(builtin)) {
      throw permissionError(`Importing '${specifier}' is not permitted inside a plugin worker.`);
    }
  }
  if (/^(data|http|https):/.test(specifier)) {
    throw permissionError(`Importing '${specifier.split(":", 1)[0]}:' modules is not permitted inside a plugin worker.`);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (loaded.format === "commonjs" || loaded.format === "addon" || loaded.format === "wasm") {
    throw permissionError(`Plugin module format '${loaded.format}' is not permitted inside a plugin worker.`);
  }
  return loaded;
}

function permissionError(message) {
  const error = new Error(message);
  error.code = "plugin_permission_denied";
  return error;
}
