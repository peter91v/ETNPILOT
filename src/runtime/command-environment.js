// @ts-check
const DEFAULT_ALLOW = Object.freeze([
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "PREFIX", "ANDROID_DATA", "ANDROID_ROOT",
]);

// Termux runs its programs through a preloaded library; without these a
// command cannot even start there. Anywhere else they are a way to inject code
// into a child process, so they are passed on only where they are needed.
const TERMUX_ONLY = Object.freeze(["LD_PRELOAD", "LD_LIBRARY_PATH"]);

function onTermux(env) {
  return typeof env.PREFIX === "string" && env.PREFIX.includes("com.termux");
}

export function commandEnvironment(env = process.env, config = {}) {
  const extra = config.envAllow ?? [];
  if (!Array.isArray(extra) || extra.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new TypeError("checks.envAllow must contain uppercase environment variable names.");
  }
  const allow = new Set([...DEFAULT_ALLOW, ...(onTermux(env) ? TERMUX_ONLY : []), ...extra]);
  const inherited = Object.fromEntries(Object.entries(env).filter(([key, value]) => allow.has(key) && value !== undefined));
  return { ...inherited, ...(config.env ?? {}), ETNPILOT_CHECK: "1" };
}
