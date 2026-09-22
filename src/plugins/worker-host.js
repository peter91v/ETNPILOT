import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertIpcMessage,
  cloneIpcValue,
  DEFAULT_PLUGIN_LIMITS,
  errorFromPayload,
  normalizePluginLimits,
  PLUGIN_PROTOCOL_VERSION,
  PluginProcessError,
  serializeError,
} from "./protocol.js";

const RUNTIME_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(RUNTIME_DIRECTORY, "worker.js");
const SDK_URL = pathToFileURL(join(RUNTIME_DIRECTORY, "sdk.js")).href;

export class PluginWorkerHost {
  #child;
  #allowedNetworkPrefixes;
  #allowedSecretNames;
  #authorizeNetwork;
  #capabilities = new Set();
  #closed = false;
  #cleanupCallbacks = [];
  #closing = false;
  #fatalError;
  #hostCalls = 0;
  #keepAlive = true;
  #invocations = new Map();
  #limits;
  #memoryTimer;
  #outputBytes = 0;
  #pending = new Map();
  #pluginName;
  #subscriptions = [];
  #exitPromise;
  #fetchImpl;
  #networkControllers = new Set();
  #resolveSecretInput;

  static async start({ specifier, projectRoot = process.cwd(), limits, moduleRoot, signal, resources = {} } = {}) {
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new TypeError("A plugin worker requires a module specifier.");
    }
    const root = resolve(projectRoot);
    const entryPath = await resolvePluginEntry(specifier, root);
    const normalizedLimits = normalizePluginLimits(limits);
    const readRoots = [RUNTIME_DIRECTORY, entryPath];
    if (moduleRoot !== undefined) readRoots.push(resolve(root, moduleRoot));
    const host = new PluginWorkerHost({
      projectRoot: root,
      entryPath,
      readRoots,
      limits: normalizedLimits,
      resources,
    });
    try {
      const manifest = await host.#request("inspect", {
        entryUrl: pathToFileURL(entryPath).href,
        sdkUrl: SDK_URL,
        maxMessageBytes: normalizedLimits.maxMessageBytes,
        callbackTimeoutMs: normalizedLimits.callTimeoutMs,
      }, { timeoutMs: normalizedLimits.setupTimeoutMs, signal });
      host.#pluginName = manifest?.name;
      host.#capabilities = new Set(manifest?.capabilities ?? []);
      return { host, manifest };
    } catch (error) {
      await host.close(error);
      throw error;
    }
  }

  constructor({ projectRoot, entryPath, readRoots, limits = DEFAULT_PLUGIN_LIMITS, resources = {} }) {
    this.#limits = limits;
    this.#allowedNetworkPrefixes = normalizeNetworkPrefixes(resources.networkAllow ?? []);
    this.#allowedSecretNames = new Set(normalizeStringList(resources.secretInputs ?? [], "Plugin secretInputs"));
    this.#authorizeNetwork = resources.authorizeNetwork;
    this.#fetchImpl = resources.fetchImpl ?? globalThis.fetch;
    this.#resolveSecretInput = resources.resolveSecret;
    const major = Number(process.versions.node.split(".", 1)[0]);
    const permissionFlag = major >= 23 ? "--permission" : "--experimental-permission";
    const execArgv = [
      `--max-old-space-size=${limits.memoryMb}`,
      permissionFlag,
      "--allow-worker",
      "--frozen-intrinsics",
      "--disable-proto=throw",
      ...[...new Set(readRoots)].map((path) => `--allow-fs-read=${path}`),
    ];
    this.#child = fork(WORKER_PATH, [], {
      cwd: projectRoot,
      env: { NODE_NO_WARNINGS: "1" },
      execArgv,
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.entryPath = entryPath;
    this.#exitPromise = new Promise((resolveExit) => {
      this.#child.once("exit", (code, signal) => {
        this.#closed = true;
        clearInterval(this.#memoryTimer);
        for (const controller of this.#networkControllers) controller.abort();
        this.#networkControllers.clear();
        const error = this.#fatalError ?? (!this.#closing
          ? new PluginProcessError(
            `Plugin worker exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
            { code: "plugin_process_exit", plugin: this.#pluginName },
          )
          : undefined);
        if (error) this.#rejectPending(error);
        this.#disposeSubscriptions();
        this.#runCleanup();
        resolveExit({ code, signal });
      });
    });
    this.#child.on("message", (message) => this.#handleMessage(message));
    this.#child.on("error", (error) => {
      this.#terminate(new PluginProcessError("Plugin worker process failed.", {
        code: "plugin_process_error",
        plugin: this.#pluginName,
        cause: error,
      }));
    });
    this.#child.stdout.on("data", (chunk) => this.#countOutput(chunk));
    this.#child.stderr.on("data", (chunk) => this.#countOutput(chunk));
    this.#memoryTimer = setInterval(() => void this.#checkMemory(), limits.memoryPollIntervalMs);
    this.#memoryTimer.unref();
  }

  get pluginName() {
    return this.#pluginName;
  }

  setup(options = {}, { signal } = {}) {
    return this.#request("setup", {
      options: cloneIpcValue(options, this.#limits.maxMessageBytes, "Plugin options"),
    }, { timeoutMs: this.#limits.setupTimeoutMs, signal });
  }

  addCleanup(callback) {
    if (typeof callback !== "function") throw new TypeError("Plugin cleanup must be a function.");
    this.#cleanupCallbacks.push(callback);
    return callback;
  }

  release() {
    this.#keepAlive = false;
    this.#unrefIfIdle();
  }

  createProvider(action) {
    return Object.freeze({
      name: action.value.name,
      capabilities: Object.freeze([...(action.value.capabilities ?? [])]),
      invoke: (context) => this.invokeProvider(action.value.name, context),
    });
  }

  createSecretProvider(action) {
    return Object.freeze({
      apiVersion: 1,
      name: action.value.name,
      type: "plugin",
      resolve: (key, context) => this.resolveSecretProvider(action.value.name, key, context),
    });
  }

  async resolveSecretProvider(provider, key, context = {}) {
    const result = await this.#request("secret.resolve", {
      provider,
      key,
      context: cloneIpcValue({ name: context.name }, this.#limits.maxMessageBytes, "Plugin secret context"),
    }, { timeoutMs: this.#limits.callTimeoutMs, signal: context.signal });
    return result === null ? undefined : result;
  }

  async invokeProvider(provider, context) {
    const invocationId = randomUUID();
    this.#invocations.set(invocationId, context);
    try {
      return await this.#request("provider.invoke", {
        provider,
        invocationId,
        context: cloneIpcValue({
          runId: context.runId,
          parentRunId: context.parentRunId,
          agent: context.agent,
          input: context.input,
          metadata: context.metadata,
          instructions: context.instructions,
          skills: context.skills,
          trace: context.trace,
        }, this.#limits.maxMessageBytes, "Plugin provider context"),
      }, { timeoutMs: this.#limits.callTimeoutMs, signal: context.signal });
    } finally {
      this.#invocations.delete(invocationId);
    }
  }

  subscribe(events, action) {
    const unsubscribe = events.on(action.eventType, (event) => this.#request("event.emit", {
      listenerId: action.listenerId,
      event: cloneIpcValue(event, this.#limits.maxMessageBytes, "Plugin event"),
    }, { timeoutMs: this.#limits.callTimeoutMs }));
    this.#subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  async close(reason) {
    if (this.#closed) return;
    this.#keepAlive = true;
    this.#ref();
    if (reason instanceof Error) {
      this.#terminate(reason);
      await this.#exitPromise;
      return;
    }
    this.#closing = true;
    this.#disposeSubscriptions();
    try {
      if (this.#child.connected) {
        await this.#request("shutdown", {}, { timeoutMs: this.#limits.shutdownTimeoutMs, fatalOnTimeout: false });
      }
    } catch {
      // The worker is killed below if it does not complete the shutdown handshake.
    }
    const exited = await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), this.#limits.shutdownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (!exited && !this.#closed) this.#child.kill("SIGKILL");
    await this.#exitPromise;
  }

  #request(method, params, { timeoutMs, signal, fatalOnTimeout = true } = {}) {
    if (this.#closed || this.#fatalError) {
      return Promise.reject(this.#fatalError ?? new PluginProcessError("Plugin worker is closed.", {
        code: "plugin_process_exit",
        plugin: this.#pluginName,
      }));
    }
    if (this.#pending.size >= this.#limits.maxPendingRequests) {
      const error = new PluginProcessError("Plugin RPC pending-request limit exceeded.", {
        code: "plugin_rpc_limit",
        plugin: this.#pluginName,
      });
      this.#terminate(error);
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    const id = randomUUID();
    const message = { v: PLUGIN_PROTOCOL_VERSION, type: "request", id, method, params };
    cloneIpcValue(message, this.#limits.maxMessageBytes, "Plugin RPC request");
    this.#ref();
    return new Promise((resolveRequest, rejectRequest) => {
      const onAbort = () => {
        const error = abortError(signal.reason);
        this.#pending.delete(id);
        this.#terminate(error);
        rejectRequest(error);
      };
      const timer = setTimeout(() => {
        const error = new PluginProcessError(`Plugin RPC '${method}' exceeded ${timeoutMs} ms.`, {
          code: "plugin_timeout",
          plugin: this.#pluginName,
        });
        this.#pending.delete(id);
        if (fatalOnTimeout) this.#terminate(error);
        rejectRequest(error);
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.#child.send(message, (error) => {
        if (!error) return;
        const request = this.#pending.get(id);
        if (!request) return;
        this.#pending.delete(id);
        clearTimeout(request.timer);
        request.cleanup();
        const wrapped = new PluginProcessError("Failed to send RPC request to plugin worker.", {
          code: "plugin_process_error",
          plugin: this.#pluginName,
          cause: error,
        });
        this.#terminate(wrapped);
        rejectRequest(wrapped);
      });
    }).finally(() => this.#unrefIfIdle());
  }

  #handleMessage(message) {
    try {
      assertIpcMessage(message, this.#limits.maxMessageBytes);
      if (message.type === "response") {
        const request = this.#pending.get(message.id);
        if (!request) return;
        this.#pending.delete(message.id);
        clearTimeout(request.timer);
        request.cleanup();
        if (message.ok) {
          request.resolve(message.result);
        } else {
          const error = errorFromPayload(message.error, this.#pluginName);
          request.reject(error);
          if (["plugin_output_limit", "plugin_protocol_error", "plugin_permission_denied"].includes(error.code)) {
            this.#terminate(error);
          }
        }
        this.#unrefIfIdle();
        return;
      }
      if (++this.#hostCalls > this.#limits.maxPendingRequests) {
        throw new PluginProcessError("Plugin host-callback limit exceeded.", {
          code: "plugin_rpc_limit",
          plugin: this.#pluginName,
        });
      }
      void this.#handleHostCall(message).finally(() => {
        this.#hostCalls -= 1;
        this.#unrefIfIdle();
      });
    } catch (error) {
      this.#terminate(error instanceof PluginProcessError ? error : new PluginProcessError(error.message, {
        code: "plugin_protocol_error",
        plugin: this.#pluginName,
        cause: error,
      }));
    }
  }

  async #handleHostCall(message) {
    try {
      let result;
      if (message.method === "runtime.secret.resolve") {
        this.#requireCapability("secret.read");
        const name = message.params?.name;
        if (typeof name !== "string" || !this.#allowedSecretNames.has(name)) {
          throw new PluginProcessError("Plugin requested a secret input outside its allowlist.", {
            code: "plugin_permission_denied",
            plugin: this.#pluginName,
          });
        }
        if (typeof this.#resolveSecretInput !== "function") {
          throw new PluginProcessError("Plugin secret inputs are unavailable.", {
            code: "plugin_permission_denied",
            plugin: this.#pluginName,
          });
        }
        result = await this.#resolveSecretInput(name);
      } else if (message.method === "runtime.network.fetch") {
        this.#requireCapability("network.fetch");
        result = await this.#performNetworkRequest(message.params?.request);
      } else {
        const invocation = this.#invocations.get(message.params?.invocationId);
        if (!invocation) throw new PluginProcessError("Plugin referenced an unknown invocation.", {
          code: "plugin_protocol_error",
          plugin: this.#pluginName,
        });
        if (message.method === "runtime.approve") {
          if (typeof invocation.approve !== "function") throw new Error("Approval is unavailable for this invocation.");
          result = await invocation.approve(message.params.request);
        } else if (message.method === "runtime.spawn") {
          if (typeof invocation.spawn !== "function") throw new Error("Subagent spawning is unavailable for this invocation.");
          result = await invocation.spawn(message.params.agent, message.params.input);
        } else {
          throw new PluginProcessError(`Plugin requested unknown host method '${message.method}'.`, {
            code: "plugin_protocol_error",
            plugin: this.#pluginName,
          });
        }
      }
      this.#send({
        v: PLUGIN_PROTOCOL_VERSION,
        type: "response",
        id: message.id,
        ok: true,
        result: cloneIpcValue(result, this.#limits.maxMessageBytes, "Plugin host result"),
      });
    } catch (error) {
      this.#send({
        v: PLUGIN_PROTOCOL_VERSION,
        type: "response",
        id: message.id,
        ok: false,
        error: serializeError(error),
      });
    }
  }

  #requireCapability(capability) {
    if (!this.#capabilities.has(capability)) {
      throw new PluginProcessError(`Plugin did not declare capability '${capability}'.`, {
        code: "plugin_permission_denied",
        plugin: this.#pluginName,
      });
    }
  }

  async #performNetworkRequest(value) {
    const request = normalizeNetworkRequest(value, this.#limits.maxMessageBytes);
    const target = new URL(request.url);
    if (!this.#allowedNetworkPrefixes.some((prefix) => matchesNetworkPrefix(target, prefix))) {
      throw new PluginProcessError("Plugin network target is outside its allowlist.", {
        code: "plugin_permission_denied",
        plugin: this.#pluginName,
      });
    }
    if (typeof this.#authorizeNetwork !== "function") {
      throw new PluginProcessError("Plugin network access requires an authorization policy.", {
        code: "plugin_permission_denied",
        plugin: this.#pluginName,
      });
    }
    const decision = await this.#authorizeNetwork({
      kind: "network",
      url: `${target.origin}${target.pathname}`,
    }, this.#pluginName);
    if (decision?.kind !== "approve-once") {
      throw new PluginProcessError("Plugin network access was not approved.", {
        code: "plugin_permission_denied",
        plugin: this.#pluginName,
      });
    }
    if (typeof this.#fetchImpl !== "function") {
      throw new PluginProcessError("No host network implementation is available.", {
        code: "plugin_process_error",
        plugin: this.#pluginName,
      });
    }
    const controller = new AbortController();
    this.#networkControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#limits.callTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.#fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new PluginProcessError("Plugin network redirects are not permitted.", {
          code: "plugin_permission_denied",
          plugin: this.#pluginName,
        });
      }
      return {
        status: response.status,
        body: await readBoundedBody(response, this.#limits.maxMessageBytes),
      };
    } catch (error) {
      if (error instanceof PluginProcessError) throw error;
      throw new PluginProcessError("Plugin network request failed.", {
        code: controller.signal.aborted ? "plugin_timeout" : "plugin_network_error",
        plugin: this.#pluginName,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      this.#networkControllers.delete(controller);
    }
  }

  #send(message) {
    cloneIpcValue(message, this.#limits.maxMessageBytes, "Plugin RPC response");
    this.#child.send(message, (error) => {
      if (error) this.#terminate(new PluginProcessError("Failed to send RPC response to plugin worker.", {
        code: "plugin_process_error",
        plugin: this.#pluginName,
        cause: error,
      }));
    });
  }

  #countOutput(chunk) {
    this.#outputBytes += chunk.length;
    if (this.#outputBytes > this.#limits.maxOutputBytes) {
      this.#terminate(new PluginProcessError(
        `Plugin process exceeded the ${this.#limits.maxOutputBytes}-byte output limit.`,
        { code: "plugin_output_limit", plugin: this.#pluginName },
      ));
    }
  }

  async #checkMemory() {
    if (this.#closed || !this.#child.pid) return;
    try {
      const status = await readFile(`/proc/${this.#child.pid}/status`, "utf8");
      const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
      if (Number.isFinite(rssKb) && rssKb > this.#limits.memoryMb * 1024) {
        this.#terminate(new PluginProcessError(
          `Plugin process exceeded the ${this.#limits.memoryMb} MiB memory limit.`,
          { code: "plugin_memory_limit", plugin: this.#pluginName },
        ));
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") {
        this.#terminate(new PluginProcessError("Plugin memory monitor failed.", {
          code: "plugin_process_error",
          plugin: this.#pluginName,
          cause: error,
        }));
      }
    }
  }

  #terminate(error) {
    if (this.#fatalError || this.#closed) return;
    this.#fatalError = error;
    this.#closing = true;
    this.#rejectPending(error);
    this.#disposeSubscriptions();
    for (const controller of this.#networkControllers) controller.abort();
    this.#networkControllers.clear();
    this.#child.kill("SIGKILL");
  }

  #rejectPending(error) {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(error);
    }
    this.#pending.clear();
  }

  #disposeSubscriptions() {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
  }

  #runCleanup() {
    for (const callback of this.#cleanupCallbacks.splice(0).reverse()) {
      try {
        callback();
      } catch {
        // Cleanup callbacks are best-effort and must not prevent process reaping.
      }
    }
  }

  #ref() {
    this.#child.ref();
    this.#child.channel?.ref?.();
    this.#child.stdout.ref?.();
    this.#child.stderr.ref?.();
  }

  #unref() {
    this.#child.unref();
    this.#child.channel?.unref?.();
    this.#child.stdout.unref?.();
    this.#child.stderr.unref?.();
  }

  #unrefIfIdle() {
    if (!this.#keepAlive && this.#pending.size === 0 && this.#hostCalls === 0) this.#unref();
  }
}

export async function resolvePluginEntry(specifier, projectRoot) {
  const candidate = isPath(specifier)
    ? resolve(projectRoot, specifier)
    : createRequire(join(projectRoot, "package.json")).resolve(specifier);
  const metadata = await stat(candidate).catch((error) => {
    throw new PluginProcessError(`Cannot resolve plugin '${specifier}'.`, {
      code: "plugin_not_found",
      cause: error,
    });
  });
  if (!metadata.isFile()) throw new PluginProcessError(`Plugin '${specifier}' is not a file.`, {
    code: "plugin_not_found",
  });
  await assertEsmEntry(candidate);
  return candidate;
}

const PLUGIN_NETWORK_HEADERS = new Set([
  "accept",
  "content-type",
  "x-vault-namespace",
  "x-vault-token",
]);

function normalizeNetworkPrefixes(values) {
  return normalizeStringList(values, "Plugin networkAllow").map((value) => {
    let prefix;
    try {
      prefix = new URL(value);
    } catch {
      throw new TypeError("Plugin networkAllow entries must be absolute HTTPS URLs.");
    }
    if (prefix.protocol !== "https:" || !prefix.hostname || prefix.username || prefix.password
      || prefix.search || prefix.hash) {
      throw new TypeError("Plugin networkAllow entries must be credential-free HTTPS URL prefixes.");
    }
    const pathname = prefix.pathname.endsWith("/") ? prefix.pathname : `${prefix.pathname}/`;
    return Object.freeze({ origin: prefix.origin, pathname });
  });
}

function matchesNetworkPrefix(target, prefix) {
  if (target.protocol !== "https:" || target.username || target.password || target.hash) return false;
  const exactPath = prefix.pathname.slice(0, -1);
  return target.origin === prefix.origin
    && (target.pathname === exactPath || target.pathname.startsWith(prefix.pathname));
}

function normalizeNetworkRequest(value, maxBytes) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new PluginProcessError("Plugin network request must be an object.", { code: "plugin_protocol_error" });
  }
  const unknown = Object.keys(value).find((key) => !["url", "method", "headers", "body"].includes(key));
  if (unknown) {
    throw new PluginProcessError(`Plugin network request has unknown field '${unknown}'.`, {
      code: "plugin_protocol_error",
    });
  }
  let target;
  try {
    target = new URL(value.url);
  } catch {
    throw new PluginProcessError("Plugin network request requires an absolute URL.", {
      code: "plugin_protocol_error",
    });
  }
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password || target.hash) {
    throw new PluginProcessError("Plugin network requests require credential-free HTTPS URLs.", {
      code: "plugin_permission_denied",
    });
  }
  const method = String(value.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) {
    throw new PluginProcessError("Plugin network method is not permitted.", { code: "plugin_permission_denied" });
  }
  if (value.body !== undefined && typeof value.body !== "string") {
    throw new PluginProcessError("Plugin network body must be a string.", { code: "plugin_protocol_error" });
  }
  if (method === "GET" && value.body !== undefined) {
    throw new PluginProcessError("Plugin GET requests cannot contain a body.", { code: "plugin_protocol_error" });
  }
  if (value.body !== undefined && Buffer.byteLength(value.body) > maxBytes) {
    throw new PluginProcessError("Plugin network body exceeds the RPC limit.", { code: "plugin_output_limit" });
  }
  const headers = {};
  if (value.headers !== undefined) {
    if (!value.headers || Array.isArray(value.headers) || typeof value.headers !== "object") {
      throw new PluginProcessError("Plugin network headers must be an object.", { code: "plugin_protocol_error" });
    }
    for (const [rawName, headerValue] of Object.entries(value.headers)) {
      const name = rawName.toLowerCase();
      if (!PLUGIN_NETWORK_HEADERS.has(name) || typeof headerValue !== "string" || headerValue.length > 16_384) {
        throw new PluginProcessError("Plugin network header is not permitted.", {
          code: "plugin_permission_denied",
        });
      }
      headers[name] = headerValue;
    }
  }
  return Object.freeze({
    url: target.href,
    method,
    headers: Object.freeze(headers),
    ...(value.body === undefined ? {} : { body: value.body }),
  });
}

async function readBoundedBody(response, maxBytes) {
  if (!response || !Number.isInteger(response.status)) {
    throw new PluginProcessError("Host network implementation returned an invalid response.", {
      code: "plugin_network_error",
    });
  }
  if (!response.body) return "";
  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PluginProcessError("Plugin network response exceeds the RPC limit.", {
          code: "plugin_output_limit",
        });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString("utf8");
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > maxBytes) {
    throw new PluginProcessError("Plugin network response exceeds the RPC limit.", {
      code: "plugin_output_limit",
    });
  }
  return body;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value)];
}

async function assertEsmEntry(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".mjs") return;
  if (extension !== ".js") {
    throw new PluginProcessError("Plugin entry points must use an ECMAScript module (.mjs or module-typed .js).", {
      code: "plugin_format_unsupported",
    });
  }
  let directory = dirname(path);
  const root = parse(directory).root;
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (packageJson.type === "module") return;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") break;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  throw new PluginProcessError("Plugin .js entry points require a package.json with type 'module'.", {
    code: "plugin_format_unsupported",
  });
}

function isPath(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/") || isAbsolute(specifier);
}

function abortError(reason) {
  const error = new PluginProcessError(
    reason instanceof Error ? reason.message : "Plugin operation was aborted.",
    { code: "plugin_aborted" },
  );
  error.name = "AbortError";
  return error;
}
