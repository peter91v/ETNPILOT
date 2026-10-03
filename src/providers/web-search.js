// @ts-check
import { storeFor } from "../auth/login.js";
import { SERVICES } from "../auth/services.js";

// The web search behind the 'web_search' tool: Brave's search API, with the key
// the person stored ('etnpilot login brave') or the environment variable. It
// returns titles, addresses and short extracts, never page bodies; reading a
// page is 'fetch_url', which asks again.

const SERVICE = SERVICES.brave;
export const SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 10;

/**
 * @param {{ query: string, count?: number, signal?: AbortSignal, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, key?: string }} options
 */
export async function braveSearch({ query, count = 5, signal, fetchImpl = globalThis.fetch, env = process.env, key }) {
  const wanted = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(count) ? count : 5));
  const url = `${SEARCH_ENDPOINT}?${new URLSearchParams({ q: query, count: String(wanted) })}`;
  const token = key ?? await searchKey(env, url);
  if (!token) {
    return { ok: false, error: `Web search needs a Brave Search API key. Run 'etnpilot login brave' (${SERVICE.keyHelp}) or set ${SERVICE.env}.` };
  }
  let response;
  try {
    response = await fetchImpl(url, { signal, headers: { accept: "application/json", "x-subscription-token": token } });
  } catch (error) {
    return { ok: false, error: `Could not reach the search service: ${error.message}` };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: `Brave Search refused the key (${response.status}).` };
  if (response.status === 429) return { ok: false, error: "Brave Search says the rate limit is used up; try again later." };
  if (!response.ok) return { ok: false, error: `Brave Search answered ${response.status}.` };
  let body;
  try { body = await response.json(); } catch { return { ok: false, error: "Brave Search sent an answer that is not JSON." }; }
  const results = (body?.web?.results ?? []).slice(0, wanted).map((entry) => ({
    title: clip(entry.title, 200),
    url: String(entry.url ?? ""),
    description: clip(strip(entry.description), 500),
    ...(entry.age || entry.page_age ? { age: String(entry.age ?? entry.page_age) } : {}),
  }));
  return { ok: true, query, results };
}

async function searchKey(env, url) {
  if (typeof env[SERVICE.env] === "string" && env[SERVICE.env] !== "") return env[SERVICE.env];
  try {
    const found = await storeFor({ env }).resolve(SERVICE.secret, { baseUrl: url });
    return found && !("refused" in found) ? found.value : undefined;
  } catch {
    return undefined;
  }
}

const strip = (text) => String(text ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'");
const clip = (text, max) => String(text ?? "").slice(0, max);
