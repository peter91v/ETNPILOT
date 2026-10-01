import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const local = (hostname) => ["localhost", "::1", "[::1]"].includes(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) throw new Error(`Offline tests refuse external fetch to ${url.hostname}.`);
  return fetch(input, options);
};
for (const module of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = module[method];
    module[method] = function (...args) {
      const input = args[0];
      const hostname = typeof input === "string" || input instanceof URL
        ? new URL(input).hostname : input?.hostname ?? input?.host ?? "localhost";
      if (!local(hostname)) throw new Error(`Offline tests refuse external ${method} to ${hostname}.`);
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
