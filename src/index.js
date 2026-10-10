import { getSandbox, proxyToSandbox, Sandbox } from "@cloudflare/sandbox";

/**
 * The Sandbox Durable Object, unchanged except that a failed request is
 * logged with its original error before it is passed on. `proxyToSandbox`
 * would otherwise report it only as OperationInterruptedError ("the platform
 * was updating the sandbox runtime").
 */
export class ReproSandbox extends Sandbox {
  async fetch(request) {
    try {
      return await super.fetch(request);
    } catch (error) {
      console.log(
        JSON.stringify({
          repro: "do-fetch-error",
          at: new Date().toISOString(),
          path: new URL(request.url).pathname,
          name: error?.name,
          message: error?.message,
          retryable: error?.retryable ?? null,
        }),
      );
      throw error;
    }
  }
}

const PORT = 5173;

// The app inside the container: a Worker, served by Vite with the Cloudflare
// plugin, that imports a JSON data file on every request. Rewriting the file
// makes the dev server reload the Worker's modules.
const INNER = {
  "/workspace/package.json": JSON.stringify({ type: "module" }),
  "/workspace/wrangler.json": JSON.stringify({
    name: "inner",
    main: "./worker.js",
    compatibility_date: "2026-09-01",
  }),
  "/workspace/vite.config.mjs": `import { cloudflare } from "@cloudflare/vite-plugin";
export default {
  plugins: [cloudflare({ inspectorPort: false, persistState: false })],
  server: { strictPort: true, watch: { usePolling: true, interval: 100 } },
};
`,
  "/workspace/worker.js": `export default {
  async fetch(request) {
    const { default: data } = await import("./data.json");
    if (new URL(request.url).pathname === "/probe") {
      return new Response(null, {
        status: 204,
        headers: { "x-ticket": String(data.ticket), "cache-control": "no-store" },
      });
    }
    return new Response("<!doctype html><p>ticket " + data.ticket + "</p>", {
      headers: { "content-type": "text/html", "cache-control": "no-store" },
    });
  },
};
`,
  "/workspace/data.json": JSON.stringify({ ticket: 0 }),
};

export default {
  async fetch(request, env) {
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, "repro", { normalizeId: true });

    if (request.method === "POST" && url.pathname === "/setup") {
      // getSandbox() sends the name without awaiting it and drops a failure;
      // exposePort() then refuses with "Sandbox name not available". Set it
      // here, awaited, so a failure is visible.
      await sandbox.setSandboxName("repro", true);
      for (const [path, content] of Object.entries(INNER)) {
        await sandbox.writeFile(path, content);
      }
      await sandbox.exec("ln -sfn /opt/repro/node_modules /workspace/node_modules");
      // Optional: a Node preload that logs the dev server's socket events
      // (sockhook.cjs), sent as the request body.
      const hook = await request.text();
      let nodeOptions = "";
      if (hook) {
        await sandbox.writeFile("/workspace/sockhook.cjs", hook);
        nodeOptions = "NODE_OPTIONS=--require=/workspace/sockhook.cjs ";
      }
      const process = await sandbox.startProcess(
        `sh -c '${nodeOptions}exec /opt/repro/node_modules/.bin/vite --config /workspace/vite.config.mjs --host 0.0.0.0 --port ${PORT} >>/tmp/vite.log 2>&1'`,
        { cwd: "/workspace" },
      );
      await process.waitForPort(PORT, { path: "/probe" });
      const exposed = await sandbox.exposePort(PORT, { hostname: url.host });
      return Response.json({ url: exposed.url });
    }

    // Replaces the data file atomically, the way the app's writer does. Each
    // write has its own temporary file, so two writes at once cannot take
    // each other's.
    if (request.method === "POST" && url.pathname === "/write") {
      const ticket = Number(url.searchParams.get("ticket"));
      if (!Number.isSafeInteger(ticket) || ticket < 0) {
        return Response.json({ error: "bad ticket" }, { status: 400 });
      }
      const temp = `/workspace/.data-${ticket}.tmp`;
      await sandbox.writeFile(temp, JSON.stringify({ ticket }));
      const moved = await sandbox.exec(`mv ${temp} /workspace/data.json`);
      if (!moved.success) {
        return Response.json({ ticket, error: moved.stderr.trim() }, { status: 500 });
      }
      return Response.json({ ticket });
    }

    if (url.pathname === "/vite-log") {
      const log = await sandbox.exec("tail -c 20000 /tmp/vite.log");
      return new Response(log.stdout);
    }

    return new Response("not found", { status: 404 });
  },
};
