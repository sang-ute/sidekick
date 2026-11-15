// Local server: serves the UI, owns the Claude Code session, fires reminders.
// Listens on 127.0.0.1 only. Every /api call needs a per-boot random token, and the
// Host header is checked, so a website you visit can't drive Claude Code through it.
//
// Runs inside the Electron app, or standalone: `npm run server` then open the printed URL.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { ClaudeSession } = require("./claude");
const reminders = require("./reminders");

const DEFAULT_PORT = 47821;
const ROOT = path.join(__dirname, "..");
const STATIC = {
  "/": ["renderer/index.html", "text/html; charset=utf-8"],
  "/style.css": ["renderer/style.css", "text/css; charset=utf-8"],
  "/app.js": ["renderer/app.js", "text/javascript; charset=utf-8"],
  "/icon.png": ["assets/icon.png", "image/png"],
};

function defaultDataDir() {
  if (process.env.SIDEKICK_DATA_DIR) return process.env.SIDEKICK_DATA_DIR;
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "sidekick"); // same folder Electron's userData uses for this app
}

function readConfig(dataDir) {
  const file = path.join(dataDir, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const merged = { effort: "low", model: null, extraAllowedTools: [], ...cfg };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2)); // writes defaults so the user can edit them
  return merged;
}

/**
 * Starts the server. Resolves to { url, port, token, events, close }.
 * events emits "reminder" (r) so the Electron shell can show native notifications.
 */
function startServer({ dataDir = defaultDataDir(), port = Number(process.env.SIDEKICK_PORT) || DEFAULT_PORT } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const events = new EventEmitter();
  const config = readConfig(dataDir);
  const claude = new ClaudeSession({ dataDir, config });
  const clients = new Set();
  let status = { state: claude.ready ? "idle" : "missing", model: null, connectors: [] };
  const history = []; // short replay buffer so a newly opened window sees the current chat

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    for (const res of clients) res.write(payload);
  }
  function record(type, data) {
    history.push({ type, data });
    if (history.length > 2000) history.splice(0, history.length - 2000);
    broadcast(type, data);
  }

  claude.on("status", (s) => { status = { ...status, ...s }; broadcast("status", status); });
  claude.on("delta", (t) => record("delta", t));
  claude.on("tool", (n) => record("tool", n));
  claude.on("note", (n) => record("note", n));
  claude.on("done", () => record("done"));
  claude.on("error", (e) => record("error", e));

  // Reminder scheduler
  const tick = () => {
    for (const r of reminders.takeDue(dataDir)) {
      record("reminder", r);
      events.emit("reminder", r);
    }
  };
  const timer = setInterval(tick, 15_000);
  tick();

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const authed = (req, url) => {
    const given = req.headers["x-sidekick-token"] || url.searchParams.get("t") || "";
    return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > 100_000) req.destroy(); });
      req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(421); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ---- static UI (no secrets in these files) ----
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return fs.createReadStream(path.join(ROOT, file)).pipe(res);
    }
    if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }
    if (!authed(req, url)) return sendJson(res, 401, { error: "bad token" });

    try {
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: hello\ndata: ${JSON.stringify({ status, history })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { text } = await readBody(req);
        if (typeof text !== "string" || !text.trim()) return sendJson(res, 400, { error: "empty message" });
        record("user", text.trim());
        claude.send(text.trim());
        return sendJson(res, 202, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        claude.reset();
        history.length = 0;
        broadcast("reset");
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/reminders") {
        return sendJson(res, 200, reminders.load(dataDir));
      }
      const del = url.pathname.match(/^\/api\/reminders\/([a-z0-9]+)$/);
      if (req.method === "DELETE" && del) {
        return sendJson(res, 200, { deleted: reminders.remove(dataDir, del[1]) });
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/#t=${token}`;
      // Warm up Claude Code in the background so the first message is fast.
      if (claude.ready) { try { claude.start(); } catch {} }
      resolve({
        url, port, token, events,
        close() { clearInterval(timer); claude.stop(); for (const c of clients) c.end(); server.close(); },
      });
    });
  });
}

module.exports = { startServer, defaultDataDir };

if (require.main === module) {
  startServer()
    .then(({ url }) => console.log(`Sidekick is running. Open:\n  ${url}`))
    .catch((err) => {
      console.error(err.code === "EADDRINUSE" ? "Port in use: Sidekick is probably already running." : err);
      process.exit(1);
    });
}
