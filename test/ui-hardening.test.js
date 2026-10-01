import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewServer, hostAllowed } from "../src/ui/server.js";

// The page is served to a browser, and a browser can be made to send a request
// to this port by a page on another site. The token is the main defence; these
// are the rest.

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-hardening-"));
  await mkdir(join(root, ".etnpilot"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\ncontent: { provenance: { mode: off } }\ncodegraph: { enabled: false }\nobservability: { enabled: false }\n");
  return root;
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("which names a request may use", () => {
  assert.equal(hostAllowed("127.0.0.1:8788"), true);
  assert.equal(hostAllowed("localhost:8788"), true);
  assert.equal(hostAllowed("[::1]:8788"), true);
  assert.equal(hostAllowed("192.168.1.20:8788"), true);
  assert.equal(hostAllowed("evil.example.com"), false);
  assert.equal(hostAllowed("evil.example.com:8788"), false);
  assert.equal(hostAllowed("phone.local", new Set(["phone.local"])), true);
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed(""), false);
});

test("a request for a name that points at this port is refused; the page cannot be framed", async () => {
  const root = await project();
  const server = await createReviewServer({ root, token: "t".repeat(24) });
  const { port } = await server.listen({ port: 0 });
  try {
    const rebound = await get(port, `/?token=${"t".repeat(24)}`, { host: `evil.example.com:${port}` });
    assert.equal(rebound.status, 421);
    assert.doesNotMatch(rebound.body, /TOKEN/);
    const api = await get(port, "/api/state", { host: "evil.example.com", "x-etnpilot-token": "t".repeat(24) });
    assert.equal(api.status, 421);

    const page = await get(port, `/?token=${"t".repeat(24)}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(page.headers["content-security-policy"], /base-uri 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    // The token leaves the address bar once the cookie holds it.
    assert.match(page.body, /history\.replaceState/);
  } finally {
    await server.close();
  }
});

test("a name the person listed is accepted", async () => {
  const root = await project();
  const server = await createReviewServer({ root, token: "t".repeat(24), allowedHosts: ["phone.local"] });
  const { port } = await server.listen({ port: 0 });
  try {
    const page = await get(port, `/?token=${"t".repeat(24)}`, { host: `phone.local:${port}` });
    assert.equal(page.status, 200);
  } finally {
    await server.close();
  }
});
