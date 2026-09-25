import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// The token that opens the review surface. It used to be minted on every
// start, which made 'etnpilot ui' print a new link each time — fine for a
// terminal, useless for an installed app: the icon on a phone's home screen
// pointed at a token that had already expired by the next restart.
//
// So it is kept, next to the other run state, and never committed:
// '.etnpilot/state/' is in the generated .gitignore. It is a credential for
// this project on this machine, so the file is written 0600 and nothing ever
// prints it but the URL itself.

export function tokenFile(root) {
  return join(resolve(root), ".etnpilot", "state", "ui-token");
}

export function mintToken() {
  return randomBytes(24).toString("base64url");
}

// Reads the token this project already has, or writes one. 'rotate' throws the
// old one away, which is what a person does when a link has been somewhere it
// should not have been.
export async function readOrCreateToken(root, { rotate = false, persist = true } = {}) {
  const path = tokenFile(root);
  if (!rotate) {
    const existing = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const trimmed = existing?.trim();
    // A file somebody edited by hand, or one truncated by a crash, is not a
    // token. Minting a new one is better than serving a guessable surface.
    if (trimmed && trimmed.length >= 16) return { token: trimmed, created: false, persisted: true, path };
  }
  const token = mintToken();
  // A directory with no project in it gets a token that lives only as long as
  // the server does. Writing one would create '.etnpilot/' behind the back of
  // a setup page whose whole promise is that nothing is touched until a
  // person chooses a template. It is persisted the moment the project is.
  if (!persist) return { token, created: true, persisted: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  // 'mode' on writeFile only applies when the file is created; an existing
  // file keeps its permissions, so a rotation tightens them too.
  await chmod(path, 0o600).catch(() => {});
  return { token, created: true, persisted: true, path, rotated: rotate };
}

// Used when a project is created through the page: the token that was only in
// memory becomes the one this project keeps.
export async function writeToken(root, token) {
  const path = tokenFile(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export async function forgetToken(root) {
  await unlink(tokenFile(root)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
