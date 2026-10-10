// SCRATCH (6.7): preloaded into astro dev. Logs per-socket HTTP events on the
// dev server's port, keyed by the peer's port (the sidecar's side).
const http = require("node:http");
const emit = http.Server.prototype.emit;
const log = (...parts) =>
  process.stderr.write(`[sock] ${new Date().toISOString()} ${parts.join(" ")}\n`);
http.Server.prototype.emit = function (event, ...args) {
  let port;
  try {
    port = this.address()?.port;
  } catch {}
  if (port === 5173) {
    if (event === "connection") {
      const socket = args[0];
      const id = socket.remotePort;
      log("open", id);
      socket.on("end", () => log("peer-FIN", id));
      socket.on("close", (hadError) => log("close", id, "hadError=" + hadError));
      socket.on("error", (error) => log("error", id, error.code));
    } else if (event === "request") {
      const [req, res] = args;
      const id = req.socket.remotePort;
      const started = Date.now();
      log("req", id, req.method, req.url.slice(0, 60), "conn=" + req.headers.connection, "len=" + (req.headers["content-length"] ?? "-"));
      res.on("finish", () =>
        log("res-finish", id, res.statusCode, "ms=" + (Date.now() - started), "keepAlive=" + res.shouldKeepAlive, "te=" + res.getHeader("transfer-encoding"), "cl=" + res.getHeader("content-length")),
      );
      res.on("close", () => log("res-close", id, "finished=" + res.writableFinished, "ms=" + (Date.now() - started)));
    }
  }
  return emit.call(this, event, ...args);
};
