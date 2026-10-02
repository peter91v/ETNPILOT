// @ts-check
import { chooseDefaultProvider, connectGitLab, gitlabState, providerChoices } from "../runtime/guided-setup.js";

// The page's side of the guided setup: what is ready, and the two choices that
// are not an account (which provider runs by default, where the work is
// published). Signing in is the accounts routes' job; this only asks the same
// module the terminal wizard asks. The token of the GitLab step arrives once,
// as it does at /api/auth/key, and is never sent back.
export function createSetupRoutes({ root, env = process.env, fetchImpl, write }) {
  const options = { root, env };
  return async function handle(method, pathname, body) {
    if (!pathname.startsWith("/api/setup")) return undefined;
    try {
      if (method === "GET" && pathname === "/api/setup") {
        return { status: 200, body: { providers: await providerChoices(options), gitlab: await gitlabState(options) } };
      }
      if (method === "POST" && pathname === "/api/setup/provider") {
        return { status: 200, body: await chooseDefaultProvider(String(body?.id ?? ""), { ...options, write }) };
      }
      if (method === "POST" && pathname === "/api/setup/gitlab") {
        const text = (value) => (typeof value === "string" ? value : undefined);
        const result = await connectGitLab({
          ...options, fetchImpl, write,
          host: text(body?.host), project: text(body?.project), user: text(body?.user)?.trim() || undefined,
          token: text(body?.token)?.trim() || undefined, remote: text(body?.remote)?.trim() || undefined,
        });
        return { status: 200, body: result };
      }
    } catch (error) {
      // A refused token is the person's to fix, not a crash.
      const status = error.code === "rejected" || /address|project|remote|token|provider|host/i.test(error.message) ? 400 : 500;
      return { status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
    }
    return undefined;
  };
}
