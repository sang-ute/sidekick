// Local server: serves the UI, owns the Claude Code session, fires reminders, runs syncs,
// keeps the notification feed, and exposes settings.
// Listens on 127.0.0.1 only. Every /api call needs a per-boot random token, and the
// Host header is checked, so a website you visit can't drive Claude Code through it.
//
// Runs inside the Electron app, or standalone: `npm run server` then open the printed URL.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");
const { ClaudeSession, cleanEnv } = require("./claude");
const cfgmod = require("./config");
const reminders = require("./reminders");
const tasks = require("./tasks");
const pkg = require("../package.json");

const DEFAULT_PORT = 47821;
const ROOT = path.join(__dirname, "..");
const STATIC = {
  "/": ["renderer/index.html", "text/html; charset=utf-8"],
  "/style.css": ["renderer/style.css", "text/css; charset=utf-8"],
  "/app.js": ["renderer/app.js", "text/javascript; charset=utf-8"],
  "/mascot": ["renderer/mascot.html", "text/html; charset=utf-8"],
  "/mascot.css": ["renderer/mascot.css", "text/css; charset=utf-8"],
  "/mascot.js": ["renderer/mascot.js", "text/javascript; charset=utf-8"],
  "/settings": ["renderer/settings.html", "text/html; charset=utf-8"],
  "/settings.css": ["renderer/settings.css", "text/css; charset=utf-8"],
  "/settings.js": ["renderer/settings.js", "text/javascript; charset=utf-8"],
  "/icon.png": ["assets/icon.png", "image/png"],
};
const CONNECTORS_URL = "https://claude.ai/settings/connectors";

function defaultDataDir() {
  if (process.env.SIDEKICK_DATA_DIR) return process.env.SIDEKICK_DATA_DIR;
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "sidekick"); // same folder Electron's userData uses for this app
}

/** Run a command and collect its output (never throws). */
function run(cmd, args, { timeout = 20_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide: true, env: cleanEnv(), maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** Open a visible terminal running a command (for interactive sign-ins). Windows only. */
function openTerminal(args) {
  if (process.platform !== "win32") throw new Error("Opening a terminal is only supported on Windows");
  const child = spawn("cmd.exe", ["/c", "start", "Sidekick sign-in", "cmd.exe", "/k", ...args], {
    detached: true, stdio: "ignore", env: cleanEnv(), windowsHide: false,
  });
  child.unref();
}

function defaultOpenExternal(url) {
  if (!/^https:\/\//.test(url)) return;
  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
function defaultOpenPath(p) {
  spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Starts the server. Resolves to { url, port, token, events, getConfig, close }.
 * events: "reminder" (r), "config" (cfg), "notify" (n) for the desktop shell.
 * Options openExternal / openPath let Electron open links and folders its own way.
 */
function startServer({
  dataDir = defaultDataDir(),
  port = Number(process.env.SIDEKICK_PORT) || DEFAULT_PORT,
  openExternal = defaultOpenExternal,
  openPath = defaultOpenPath,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const token = crypto.randomBytes(24).toString("hex");
  const events = new EventEmitter();
  let config = cfgmod.load(dataDir);
  cfgmod.save(dataDir, config); // writes defaults so they're visible in the file
  const claude = new ClaudeSession({ dataDir, config });
  const clients = new Set();
  let status = { state: claude.ready ? "idle" : "missing", model: null, connectors: [] };
  const history = []; // replay buffer so a newly opened window sees the current chat

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    for (const res of clients) res.write(payload);
  }
  function record(type, data) {
    history.push({ type, data });
    if (history.length > 2000) history.splice(0, history.length - 2000);
    broadcast(type, data);
  }

  // ---------- notification feed (for the mascot's notifier) ----------
  const notifFile = path.join(dataDir, "notifications.json");
  let notifications = [];
  try { notifications = JSON.parse(fs.readFileSync(notifFile, "utf8")); } catch {}
  const saveNotifs = () => fs.writeFileSync(notifFile, JSON.stringify(notifications, null, 2));
  function notify(kind, title, body = "", link = "") {
    const n = {
      id: crypto.randomBytes(4).toString("hex"),
      kind, title: String(title).slice(0, 160), body: String(body).slice(0, 400),
      link: /^https?:\/\//.test(link) ? link : "",
      at: new Date().toISOString(),
    };
    notifications.unshift(n); // newest first
    notifications.length = Math.min(notifications.length, 50);
    saveNotifs();
    broadcast("notify", n);
    events.emit("notify", n);
  }

  // ---------- Claude Code session ----------
  let reply = ""; // text of the answer being streamed
  let syncing = null; // { newTasks: [] } while a sync runs
  claude.on("status", (s) => { status = { ...status, ...s }; broadcast("status", status); });
  claude.on("delta", (t) => { reply += t; record("delta", t); });
  claude.on("tool", (n) => record("tool", n));
  claude.on("note", (n) => record("note", n));
  claude.on("done", () => {
    record("done");
    if (syncing) {
      const n = syncing.newTasks.length;
      notify("sync", n ? `Sync finished · ${n} new task${n === 1 ? "" : "s"}` : "Sync finished · nothing new", reply.trim());
      syncing = null;
    }
  });
  claude.on("error", (e) => {
    record("failure", e);
    if (syncing) { notify("error", "Sync didn't finish", e); syncing = null; }
    else if (!/^Still working/.test(e)) notify("error", "Something went wrong", e);
  });

  // ---------- files other processes change (Claude edits them through MCP) ----------
  const tasksFile = path.join(dataDir, "tasks.json");
  const remindersFile = path.join(dataDir, "reminders.json");
  const configFile = path.join(dataDir, "config.json");
  tasks.prune(dataDir);
  let knownTaskIds = new Set(tasks.load(dataDir).map((t) => t.id));
  function pushTasks() {
    const list = tasks.load(dataDir);
    for (const t of list) {
      if (knownTaskIds.has(t.id) || t.source === "me") continue;
      if (syncing) syncing.newTasks.push(t); // summed up in the sync notification
      else notify("task", `New task: ${t.title}`, t.notes || "", t.link);
    }
    knownTaskIds = new Set(list.map((t) => t.id));
    broadcast("tasks", list);
  }
  const pushReminders = () => broadcast("reminders", reminders.load(dataDir));
  function reloadConfigFromDisk() {
    const fresh = cfgmod.load(dataDir);
    if (JSON.stringify(fresh) === JSON.stringify(config)) return;
    applyConfig(fresh);
  }
  fs.watchFile(tasksFile, { interval: 1000 }, pushTasks);
  fs.watchFile(remindersFile, { interval: 1000 }, pushReminders);
  fs.watchFile(configFile, { interval: 1500 }, reloadConfigFromDisk);

  function applyConfig(next) {
    const aiChanged = cfgmod.AI_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(config[k]));
    config = next;
    broadcast("config", config);
    events.emit("config", config);
    if (aiChanged) claude.restart(config);
    else claude.config = config;
  }

  // ---------- sync: GitHub + Gmail + YouTube → task board ----------
  const stateFile = path.join(dataDir, "state.json");
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
  function syncPrompt() {
    const on = config.integrations;
    const parts = [on.github && "my GitHub inbox", on.gmail && "my Gmail if it's connected",
      on.calendar && "my Google Calendar if it's connected", on.youtube && "new videos from the YouTube channels I follow"].filter(Boolean);
    const what = parts.length ? parts.join(", ") : "my task board";
    return `Sync now: check ${what}. Put what I need to act on onto the task board (skip anything already there), then give me a short summary.`;
  }
  function sync(reason) {
    if (claude.busy || !claude.ready) return false;
    fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), lastSync: today() }));
    syncing = { newTasks: [] };
    reply = "";
    record("user", reason === "daily" ? "🗞 Daily sync…" : "🔄 Sync…");
    claude.send(syncPrompt());
    return true;
  }

  // ---------- scheduler: reminders every 15s, daily sync once a day ----------
  const tick = () => {
    for (const r of reminders.takeDue(dataDir)) {
      record("reminder", r);
      events.emit("reminder", r);
      notify("reminder", r.text, r.repeat && r.repeat !== "none" ? `Repeats ${r.repeat}` : "Reminder");
    }
    const at = config.dailySyncTime;
    // Test runs (separate data folder or screenshot mode) never start a real sync on their own.
    const testing = process.env.SIDEKICK_DATA_DIR || process.env.SIDEKICK_SMOKE;
    if (!testing && /^\d{2}:\d{2}$/.test(at || "") && readState().lastSync !== today()) {
      const hhmm = new Date().toTimeString().slice(0, 5);
      if (hhmm >= at) sync("daily"); // also catches up right after boot if the PC was off at sync time
    }
  };
  const timer = setInterval(tick, 15_000);
  setTimeout(tick, 5_000); // give Claude Code a moment to start before a catch-up sync

  // ---------- info for the settings dashboard ----------
  let mcpCache = { at: 0, list: [] };
  async function mcpList() {
    if (Date.now() - mcpCache.at < 60_000) return mcpCache.list;
    if (!claude.claudePath) return [];
    const r = await run(claude.claudePath, ["mcp", "list"], { timeout: 45_000, cwd: claude.workDir });
    const list = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^(.+?): (\S.*) - (.+)$/);
      if (!m) continue;
      const s = m[3].toLowerCase();
      const state = /connected/.test(s) && !/fail|not/.test(s) ? "connected"
        : /auth/.test(s) ? "needs-auth" : /pending/.test(s) ? "pending" : "failed";
      list.push({ name: m[1].trim(), status: state, source: m[1].startsWith("claude.ai ") ? "claudeai" : "user" });
    }
    mcpCache = { at: Date.now(), list };
    return list;
  }
  async function info() {
    const claudeP = claude.claudePath;
    const [ver, auth, ghStatus, mcp] = await Promise.all([
      claudeP ? run(claudeP, ["--version"], { timeout: 15_000 }) : null,
      claudeP ? run(claudeP, ["auth", "status"], { timeout: 15_000 }) : null,
      run("gh", ["auth", "status"], { timeout: 15_000 }),
      mcpList(),
    ]);
    let authInfo = null;
    try {
      const a = JSON.parse(auth.stdout);
      authInfo = {
        loggedIn: Boolean(a.loggedIn), authMethod: a.authMethod || null, apiProvider: a.apiProvider || null,
        subscriptionType: a.subscriptionType || null, email: a.email || null, orgName: a.orgName || null,
      };
    } catch {}
    const ghText = ghStatus.stdout + ghStatus.stderr;
    const ghMissing = !ghStatus.ok && /ENOENT|not recognized/i.test(ghText + ghStatus.code);
    // Live status from the running session wins over `claude mcp list`.
    const byName = new Map(mcp.map((c) => [c.name, c]));
    for (const c of status.connectors || []) {
      byName.set(c.name, { name: c.name, status: c.status, source: c.name === "sidekick" ? "sidekick" : (byName.get(c.name)?.source || (c.name.startsWith("claude.ai ") ? "claudeai" : "user")) });
    }
    if (!byName.has("sidekick")) byName.set("sidekick", { name: "sidekick", status: claude.ready ? "connected" : "failed", source: "sidekick" });
    return {
      app: {
        name: "Sidekick", version: pkg.version,
        electron: process.versions.electron || null, chrome: process.versions.chrome || null,
        node: process.versions.node, platform: `${os.type()} ${os.release()}`, arch: process.arch,
      },
      dataDir,
      claude: {
        found: Boolean(claudeP), path: claudeP,
        version: ver && ver.ok ? ver.stdout.trim().split(/\s/)[0] : null,
        auth: authInfo,
      },
      github: {
        installed: !ghMissing,
        loggedIn: /Logged in to/i.test(ghText),
        user: (ghText.match(/account (\S+)/) || [])[1] || null,
      },
      connectors: [...byName.values()],
    };
  }

  // ---------- custom mascot image ----------
  const SKIN_TYPES = { png: "image/png", gif: "image/gif", webp: "image/webp" };
  function findSkin() {
    for (const [ext, type] of Object.entries(SKIN_TYPES)) {
      const file = path.join(dataDir, `mascot.${ext}`);
      if (fs.existsSync(file)) return { file, type };
    }
    return null;
  }

  // ---------- HTTP ----------
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
      req.on("data", (c) => { s += c; if (s.length > 200_000) req.destroy(); });
      req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { e.status = 400; reject(e); } });
      req.on("error", reject);
    });

  const routes = {
    "GET /api/events": (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const hello = {
        status, history, config,
        tasks: tasks.load(dataDir), reminders: reminders.load(dataDir), notifications,
        skin: Boolean(findSkin()),
      };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
    },

    // chat
    "POST /api/chat": async (req, res) => {
      const { text } = await readBody(req);
      if (typeof text !== "string" || !text.trim()) return sendJson(res, 400, { error: "empty message" });
      reply = "";
      record("user", text.trim());
      claude.send(text.trim());
      sendJson(res, 202, { ok: true });
    },
    "POST /api/reset": (req, res) => {
      claude.reset();
      history.length = 0;
      broadcast("reset");
      sendJson(res, 200, { ok: true });
    },
    "POST /api/sync": (req, res) =>
      sync("manual") ? sendJson(res, 202, { ok: true }) : sendJson(res, 409, { error: "Busy, try again in a moment" }),

    // reminders & tasks
    "GET /api/reminders": (req, res) => sendJson(res, 200, reminders.load(dataDir)),
    "GET /api/tasks": (req, res) => sendJson(res, 200, tasks.load(dataDir)),
    "POST /api/tasks": async (req, res) => {
      const { title } = await readBody(req);
      if (typeof title !== "string" || !title.trim()) return sendJson(res, 400, { error: "empty task" });
      const r = tasks.add(dataDir, { title: title.trim(), source: "me" });
      pushTasks();
      sendJson(res, 201, r);
    },

    // notifications
    "POST /api/notifications/clear": (req, res) => {
      notifications = [];
      saveNotifs();
      broadcast("notifications", notifications);
      sendJson(res, 200, { ok: true });
    },

    // settings
    "GET /api/settings": (req, res) =>
      sendJson(res, 200, { config, defaults: cfgmod.DEFAULTS, options: cfgmod.OPTIONS }),
    "PATCH /api/settings": async (req, res) => {
      const patch = await readBody(req);
      const current = cfgmod.load(dataDir); // fresh: Claude may have changed it (youtube_follow)
      const clean = cfgmod.validatePatch(patch, current);
      const next = { ...current, ...clean };
      cfgmod.save(dataDir, next);
      applyConfig(next);
      sendJson(res, 200, { config });
    },
    "GET /api/info": async (req, res) => sendJson(res, 200, await info()),

    // account & connections
    "POST /api/claude/login": async (req, res) => {
      const { method } = await readBody(req);
      if (!claude.claudePath) return sendJson(res, 400, { error: "Claude Code isn't installed" });
      if (!["claudeai", "console"].includes(method)) return sendJson(res, 400, { error: "method must be claudeai or console" });
      openTerminal([claude.claudePath, "auth", "login", `--${method}`]);
      mcpCache.at = 0;
      sendJson(res, 200, { ok: true });
    },
    "POST /api/claude/logout": async (req, res) => {
      if (!claude.claudePath) return sendJson(res, 400, { error: "Claude Code isn't installed" });
      const r = await run(claude.claudePath, ["auth", "logout"], { timeout: 20_000 });
      claude.restart(config);
      const a = await run(claude.claudePath, ["auth", "status"], { timeout: 15_000 });
      let auth = null;
      try { auth = JSON.parse(a.stdout); } catch {}
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, auth } : { error: (r.stderr || r.stdout).trim() || "Sign-out failed" });
    },
    "POST /api/claude/restart": (req, res) => { claude.restart(config); sendJson(res, 200, { ok: true }); },
    "POST /api/github/login": (req, res) => { openTerminal(["gh", "auth", "login"]); sendJson(res, 200, { ok: true }); },
    "POST /api/mcp/login": async (req, res) => {
      const { name } = await readBody(req);
      const known = (await mcpList()).map((c) => c.name).concat((status.connectors || []).map((c) => c.name));
      if (typeof name !== "string" || !known.includes(name) || !/^[\w .-]{1,80}$/.test(name)) {
        return sendJson(res, 400, { error: "Unknown MCP server" });
      }
      openTerminal([claude.claudePath, "mcp", "login", name]);
      mcpCache.at = 0;
      sendJson(res, 200, { ok: true });
    },
    "POST /api/open": async (req, res) => {
      const { target } = await readBody(req);
      if (target === "connectors") openExternal(CONNECTORS_URL);
      else if (target === "dataFolder") openPath(dataDir);
      else return sendJson(res, 400, { error: "Unknown target" });
      sendJson(res, 200, { ok: true });
    },
  };

  const server = http.createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(421); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ---- static UI (no secrets in these files) ----
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return fs.createReadStream(full).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/skin") {
      const skin = findSkin();
      if (!skin) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": skin.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return fs.createReadStream(skin.file).pipe(res);
    }
    if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }
    if (!authed(req, url)) return sendJson(res, 401, { error: "bad token" });

    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return await route(req, res, url);

      // routes with an id
      let m;
      if ((m = url.pathname.match(/^\/api\/reminders\/([a-z0-9]+)$/)) && req.method === "DELETE") {
        return sendJson(res, 200, { deleted: reminders.remove(dataDir, m[1]) });
      }
      if ((m = url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)$/))) {
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const task = tasks.update(dataDir, m[1], { done: body.done, title: body.title });
          pushTasks();
          return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: "no such task" });
        }
        if (req.method === "DELETE") {
          const deleted = tasks.remove(dataDir, m[1]);
          pushTasks();
          return sendJson(res, 200, { deleted });
        }
      }
      if ((m = url.pathname.match(/^\/api\/notifications\/([a-f0-9]+)$/)) && req.method === "DELETE") {
        const before = notifications.length;
        notifications = notifications.filter((n) => n.id !== m[1]);
        saveNotifs();
        broadcast("notifications", notifications);
        return sendJson(res, 200, { deleted: notifications.length !== before });
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, err.status || 500, { error: String(err.message || err) });
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
        getConfig: () => config,
        close() {
          clearInterval(timer);
          for (const f of [tasksFile, remindersFile, configFile]) fs.unwatchFile(f);
          claude.stop();
          for (const c of clients) c.end();
          server.close();
        },
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
