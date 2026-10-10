# sandbox-port-close-repro

A standalone reproduction: a request proxied into a Sandbox container port
fails with `Container port connection closed unexpectedly.`, which
`proxyToSandbox` reports as `OperationInterruptedError` ("the platform was
updating the sandbox runtime") and a 500 "Proxy routing error".

No application code beyond this directory. Local development only
(`wrangler dev` with local Docker containers).

## What it does

- `src/index.js` — a Worker with a Sandbox Durable Object (`ReproSandbox`,
  the SDK's `Sandbox` plus one `console.log` of the original error in
  `fetch`). `POST /setup` writes a small app into the container and starts
  Vite with `@cloudflare/vite-plugin` on port 5173. The app is itself a
  Worker that imports `data.json` on each request: `/probe` answers 204 with
  the file's `ticket`, `/` answers a small HTML page. `POST /write?ticket=N`
  replaces `data.json` atomically (`writeFile` to a temp file of its own,
  then `mv`) and answers 500 if the move fails.
- `driver.mjs` — per iteration, two "syncs", then one request for `/`, all
  through `proxyToSandbox`. A sync writes a ticket, then polls `/probe` every
  100 ms (up to 10 s) until it reports that ticket. The polling continues
  after a failed probe, and each failure is counted as `probeErrors`. A
  failed write is recorded as `writeError` and not polled for. The page
  request is never retried. Nothing else retries. One JSON line per
  iteration. Conditions: `seq` (second sync after the first finished), a
  number (second sync started that many ms after the first), `none` (no
  sync), `pair` (no sync; two page requests at once before the recorded one).
- `sockhook.cjs` — optional (`SOCKHOOK=1`): preloaded into the container's
  Vite; logs every connection, request, response end (with Node's
  keep-alive decision), peer FIN and close on port 5173, keyed by the peer's
  port.

## Run

Each driver run must start from a **freshly started container**. The sandbox
name is fixed (`repro`) and `/setup` does not stop a Vite started by an
earlier run, so do not run the driver twice against one `wrangler dev`.

```bash
npm ci       # @cloudflare/sandbox 0.12.7, wrangler 4.146.0, from package-lock.json
```

For each run:

1. Start: `./node_modules/.bin/wrangler dev --port 8787` (the first start
   builds the container image from `Dockerfile`).
2. In another terminal, run one driver command:

   ```bash
   CONDITIONS=seq node driver.mjs                  # main case: sequential syncs only
   node driver.mjs                                 # seq, 0, 300, 500, 1000 ms (overlapping syncs)
   CONDITIONS=none,pair,none,seq node driver.mjs   # requests without writes first
   SOCKHOOK=1 CONDITIONS=seq node driver.mjs       # main case with socket logging
   ```

   Optional, before stopping: `curl -s http://127.0.0.1:8787/vite-log`
   (Vite output, and `[sock]` lines with `SOCKHOOK=1`).
3. Stop `wrangler dev` (Ctrl-C) and wait until it has exited.
4. Check that no container of this Worker is left, and remove any that is:

   ```bash
   docker ps -a --filter name=ReproSandbox --format '{{.ID}} {{.Names}}'
   docker rm -f <id>   # only for ids listed above
   ```

The original error is printed by `ReproSandbox.fetch` in the wrangler output
as `{"repro":"do-fetch-error",...}`.

`Dockerfile` installs the container's toolchain with `npm ci` from
`container/package-lock.json`.

The runs recorded so far (`evidence/repro-runs/`) did not use that path:
they used `Dockerfile.local`, which copies node_modules holding the same
direct versions from an image already on the machine, and the host's
`node_modules` was linked to an existing install. The transitive versions of
those installs can differ from the lockfiles. Runs of the public path
(`npm ci` from both lockfiles, the public `Dockerfile`) are in
`evidence/public-path/`.

Run names used in the report:

| Report | Directory |
|---|---|
| P1 | `evidence/public-path/run-default/` |
| P2 | `evidence/public-path/run-baseline/` |
| P3 | `evidence/public-path/run-seq-fixed/` |
| P4 | `evidence/public-path/run-default-fixed/` |
| run 1 | `evidence/repro-runs/20261010-144545-third/` |
| run 2 | `evidence/repro-runs/20261010-150836-fourth/` |
| run 3 | `evidence/repro-runs/20261010-145601-baseline/` |
| run 4 | `evidence/repro-runs/20261010-152956-sockhook/` |

P1, P2 and runs 1-4 used an earlier `src/index.js` in which every write
used the same temporary file and the driver did not check the write
response; P3 and P4 use the current files.
