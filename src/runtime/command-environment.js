const DEFAULT_ALLOW = Object.freeze([
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "PREFIX", "ANDROID_DATA", "ANDROID_ROOT",
]);

export function commandEnvironment(env = process.env, config = {}) {
  const extra = config.envAllow ?? [];
  if (!Array.isArray(extra) || extra.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new TypeError("checks.envAllow must contain uppercase environment variable names.");
  }
  const allow = new Set([...DEFAULT_ALLOW, ...extra]);
  const inherited = Object.fromEntries(Object.entries(env).filter(([key, value]) => allow.has(key) && value !== undefined));
  return { ...inherited, ...(config.env ?? {}), ETNPILOT_CHECK: "1" };
}
