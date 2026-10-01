// @ts-check
// Some failures are expected and ignoring them is right: a file that is not
// there yet, a best-effort cleanup. Ignoring them silently is a different
// matter when the thing that failed is why something looks empty or wrong.
// This is the one way to say "carry on without it" that still leaves a trace:
// with ETNPILOT_DEBUG set, what was swallowed and where is written to stderr.
export function swallow(where, fallback) {
  return (error) => {
    if (process.env.ETNPILOT_DEBUG) {
      process.stderr.write(`[etnpilot debug] ${where}: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}\n`);
    }
    return typeof fallback === "function" ? fallback() : fallback;
  };
}
