import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SUPPORTED_RUNTIMES = new Set(["docker", "podman"]);
const DEFAULTS = Object.freeze({
  runtime: "docker",
  image: "node:24-bookworm-slim",
  network: "none",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  memory: undefined,
  cpus: undefined,
  user: undefined,
  extraArgs: [],
});

// An approved shell command is the widest hole in the policy: it runs with the
// operator's privileges and reaches whatever that process can reach. A sandbox
// closes it by running commands in a disposable container that sees only the
// workspace and, by default, no network.
export function createSandbox(config = {}, { workspace, probe = probeRuntime } = {}) {
  if (config.enabled !== true) return undefined;
  if (!workspace) throw new TypeError("A sandbox requires a workspace path.");
  const options = normalizeSandbox(config);
  const root = resolve(workspace);
  let availability;

  return {
    options,
    workspace: root,
    describe: () => ({
      runtime: options.runtime,
      image: options.image,
      network: options.network,
      readOnlyRoot: options.readOnlyRoot,
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.cpus ? { cpus: options.cpus } : {}),
    }),
    async assertAvailable() {
      availability ??= await probe(options.runtime);
      if (availability.available) return availability;
      // Never silently downgrade to running on the host: the operator asked
      // for containment, and a quiet fallback would remove it.
      throw new Error(
        `Sandbox runtime '${options.runtime}' is not available: ${availability.reason}.`
        + " Install it, or set sandbox.enabled to false to accept host execution.",
      );
    },
    wrap(command, { env = {}, cwd } = {}) {
      return buildSandboxCommand(command, {
        ...options,
        workspace: root,
        envNames: Object.keys(env),
        cwd,
      });
    },
  };
}

export function buildSandboxCommand(command, options) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new TypeError("A sandboxed command must be a non-empty array of strings.");
  }
  const workdir = options.cwd
    ? joinPosix(options.workdir, relativeWithin(options.workspace, options.cwd))
    : options.workdir;
  const args = [
    "run", "--rm", "--init",
    `--network=${options.network}`,
    "--workdir", workdir,
    "--volume", `${options.workspace}:${options.workdir}`,
  ];
  if (options.readOnlyRoot) args.push("--read-only");
  for (const path of options.tmpfs) args.push("--tmpfs", path);
  if (options.user) args.push("--user", options.user);
  if (options.memory) args.push(`--memory=${options.memory}`);
  if (options.cpus) args.push(`--cpus=${options.cpus}`);
  // Values are inherited from the runtime client's own environment, so no
  // secret is ever visible in the process list.
  for (const name of options.envNames ?? []) args.push("--env", name);
  args.push(...options.extraArgs, options.image, ...command);
  return [options.runtime, ...args];
}

function normalizeSandbox(config) {
  const options = { ...DEFAULTS, ...config };
  if (!SUPPORTED_RUNTIMES.has(options.runtime)) {
    throw new TypeError(`Unsupported sandbox runtime '${options.runtime}'. Use docker or podman.`);
  }
  if (typeof options.image !== "string" || options.image.length === 0) {
    throw new TypeError("sandbox.image must be a non-empty string.");
  }
  if (!["none", "bridge", "host"].includes(options.network)) {
    throw new TypeError(`Unsupported sandbox network '${options.network}'. Use none, bridge, or host.`);
  }
  if (!Array.isArray(options.extraArgs) || options.extraArgs.some((arg) => typeof arg !== "string")) {
    throw new TypeError("sandbox.extraArgs must be an array of strings.");
  }
  if (!Array.isArray(options.tmpfs) || options.tmpfs.some((path) => typeof path !== "string")) {
    throw new TypeError("sandbox.tmpfs must be an array of strings.");
  }
  if (!options.workdir.startsWith("/")) throw new TypeError("sandbox.workdir must be an absolute container path.");
  return Object.freeze({ ...options, tmpfs: Object.freeze([...options.tmpfs]), extraArgs: Object.freeze([...options.extraArgs]) });
}

function relativeWithin(root, target) {
  const relative = resolve(target).slice(resolve(root).length).replaceAll("\\", "/");
  if (resolve(target) !== resolve(root) && !resolve(target).startsWith(`${resolve(root)}/`)) {
    throw new Error("A sandboxed working directory must stay inside the workspace.");
  }
  return relative.replace(/^\//, "");
}

function joinPosix(base, segment) {
  return segment ? `${base.replace(/\/$/, "")}/${segment}` : base;
}

function probeRuntime(runtime) {
  return new Promise((resolveProbe) => {
    const child = spawn(runtime, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    child.once("error", (error) => resolveProbe({ available: false, reason: error.code ?? error.message }));
    child.once("exit", (code) => resolveProbe(code === 0
      ? { available: true }
      : { available: false, reason: `'${runtime} info' exited with ${code}` }));
  });
}
