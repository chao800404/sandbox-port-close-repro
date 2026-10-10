// Drives the repro Worker running under `wrangler dev`.
//
// Each iteration does two "syncs": a sync writes the container's data file
// with a new ticket, then polls the inner Worker's /probe (through
// proxyToSandbox) until it reports that ticket. The second sync starts `gap`
// ms after the first, or after it finished ("seq"). Right after both, one
// page request goes through the same proxy. No request is retried.
//
// Prints one JSON line per iteration. BASE defaults to http://127.0.0.1:8787;
// ROUNDS to 3; SOCKHOOK=1 preloads sockhook.cjs into the container's Vite.
import http from "node:http";
import { readFileSync } from "node:fs";

const BASE = new URL(process.env.BASE ?? "http://127.0.0.1:8787");
const ROUNDS = Number(process.env.ROUNDS ?? "3");
const CONDITIONS = (process.env.CONDITIONS ?? "seq,0,300,500,1000").split(",");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(path, { method = "GET", host, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port,
        path,
        method,
        headers: { ...(host ? { host } : {}), "cache-control": "no-store" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// The preview URL is a subdomain of the host /setup is called on; an IP
// address cannot take one, so name the host.
const setup = await request("/setup", {
  method: "POST",
  host: `localhost:${BASE.port}`,
  body: process.env.SOCKHOOK === "1" ? readFileSync(new URL("./sockhook.cjs", import.meta.url)) : "",
});
if (setup.status !== 200) throw new Error(`setup ${setup.status}: ${setup.body}`);
const previewHost = new URL(JSON.parse(setup.body).url).host;
console.log(JSON.stringify({ event: "setup", previewHost: previewHost.replace(/-[a-z0-9_]+\./, "-<token>.") }));
if (!previewHost.startsWith("5173-")) throw new Error(`not a preview host: ${previewHost}`);

let ticket = 0;
async function sync() {
  const own = ++ticket;
  const started = Date.now();
  const written = await request(`/write?ticket=${own}`, { method: "POST" });
  if (written.status !== 200) {
    // A failed write is reported, never polled for.
    return { own, read: null, ms: Date.now() - started, probeErrors: 0, writeError: `${written.status} ${written.body.slice(0, 120)}` };
  }
  let probeErrors = 0;
  while (Date.now() - started < 10_000) {
    const probe = await request("/probe", { host: previewHost }).catch(() => null);
    if (probe?.status === 204 && Number(probe.headers["x-ticket"]) >= own) {
      return { own, read: Number(probe.headers["x-ticket"]), ms: Date.now() - started, probeErrors };
    }
    if (!probe || probe.status >= 500) probeErrors++;
    await sleep(100);
  }
  return { own, read: null, ms: Date.now() - started, probeErrors };
}

for (let round = 0; round < ROUNDS; round++) {
  for (const condition of CONDITIONS) {
    await sleep(2_500);
    let first = null;
    let second = null;
    if (condition === "none") {
      // No write: the page request alone.
    } else if (condition === "pair") {
      // No write: two page requests at once, then the one recorded below.
      first = (await Promise.all([request("/", { host: previewHost }), request("/", { host: previewHost })]))
        .map((r) => r.status);
    } else if (condition === "seq") {
      first = await sync();
      second = await sync();
    } else {
      const pending = sync();
      await sleep(Number(condition));
      [first, second] = await Promise.all([pending, sync()]);
    }
    const at = new Date().toISOString();
    const page = await request("/", { host: previewHost });
    console.log(
      JSON.stringify({
        round,
        condition,
        at,
        first,
        second,
        pageStatus: page.status,
        pageBody: page.body.slice(0, 60),
      }),
    );
  }
}
