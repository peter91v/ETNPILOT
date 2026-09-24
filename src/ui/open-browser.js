import { spawn as spawnProcess } from "node:child_process";

// Opening the review page where it was asked for. This is the one place that
// starts a program outside ETNPilot, so it is deliberate about it: the URL is
// passed as an argument and never through a shell, a missing opener is an
// answer rather than a crash, and nothing here can fail the command that
// printed the URL.

const EXIT_GRACE_MS = 700;

export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  const chosen = typeof env.BROWSER === "string" ? env.BROWSER.trim() : "";
  // BROWSER is the convention other tools follow; 'none' is how a person says
  // 'never open anything'.
  if (chosen && chosen.toLowerCase() !== "none") return [[chosen, []]];
  if (platform === "darwin") return [["open", []]];
  if (platform === "win32") return [["cmd", ["/c", "start", ""]]];
  return [
    // Termux first where it exists: Android has no xdg-open, and the roadmap's
    // own end-to-end run was on a phone.
    ["termux-open-url", []],
    ["xdg-open", []],
    ["wslview", []],
    ["gio", ["open"]],
    ["x-www-browser", []],
    ["sensible-browser", []],
  ];
}

export async function openInBrowser(url, {
  platform = process.platform,
  env = process.env,
  spawn = spawnProcess,
  graceMs = EXIT_GRACE_MS,
} = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new TypeError("A http(s) URL is required to open a browser.");
  }
  if (typeof env.BROWSER === "string" && env.BROWSER.trim().toLowerCase() === "none") {
    return { opened: false, reason: "BROWSER is set to 'none'." };
  }
  const tried = [];
  for (const [command, args] of browserCandidates({ platform, env })) {
    const result = await attempt(command, [...args, url], { spawn, graceMs });
    if (result.opened) return { opened: true, command };
    tried.push(`${command}: ${result.reason}`);
  }
  return {
    opened: false,
    reason: tried.length === 0 ? "no browser opener is configured." : `no browser opener worked (${tried.join("; ")}).`,
  };
}

function attempt(command, args, { spawn, graceMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      // Detached and with no pipes: the browser outlives this command and
      // never writes into the terminal the page's URL was printed on.
      child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
    } catch (error) {
      resolve({ opened: false, reason: error.message });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // An opener that exits at once with an error has not opened anything, and
    // the next candidate should get its turn. One that is still running has.
    // Not unref'd: this timer is what settles the promise, and it is bounded
    // by graceMs. The child is released instead, so the browser outlives us.
    const timer = setTimeout(() => {
      child.unref?.();
      finish({ opened: true });
    }, graceMs);
    child.once("error", (error) => finish({ opened: false, reason: error.code === "ENOENT" ? "not installed" : error.message }));
    child.once("exit", (code) => {
      child.unref?.();
      finish(code === 0 ? { opened: true } : { opened: false, reason: `exited with ${code}` });
    });
  });
}
