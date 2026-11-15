// Regenerates docs/screenshots/*.png for the README and release notes.
// Runs the real server and windows against neutral sample data (nothing personal),
// masks any email address, and refuses to save a settings shot if one is visible.
// Includes one short real chat through Claude Code (uses a little of your plan).
//   npm run screenshots
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const DATA = path.join(require("os").tmpdir(), "sidekick-screenshots");
const PORT = 47920;
const PRELOAD = path.join(ROOT, "src", "preload.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.SIDEKICK_DATA_DIR = DATA; // also disables the automatic daily sync
process.env.SIDEKICK_PORT = String(PORT);

// ---------- sample data (neutral, nothing personal) ----------
function seed() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const t = (id, title, source, extra = {}) => ({
    id, title, notes: "", source, link: "", due: null, done: false,
    createdAt: iso(-3600e3), doneAt: null, ...extra,
  });
  fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify([
    t("a1", "Reply to recruiter about Friday interview", "gmail", { notes: "They asked for two time slots", due: iso(20 * 3600e3) }),
    t("a2", "Review PR #12: dark mode toggle", "github", { link: "https://github.com/example/app/pull/12", notes: "Review requested" }),
    t("a3", "Fix #8: login form loses focus on error", "github", { link: "https://github.com/example/app/issues/8" }),
    t("a4", "Watch: Building desktop apps with Electron", "youtube", { link: "https://www.youtube.com/" }),
    t("a5", "Prepare slides for Thursday demo", "calendar", { due: iso(3 * 86400e3) }),
    t("a6", "Update CV with the Sidekick project", "me"),
    t("a7", "Book dentist appointment", "me", { done: true, doneAt: iso(-1800e3) }),
  ], null, 2));
  fs.writeFileSync(path.join(DATA, "reminders.json"), JSON.stringify([
    { id: "r1", text: "Team standup", dueAt: iso(25 * 60e3), repeat: "daily", createdAt: iso(-86400e3) },
  ], null, 2));
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({
    theme: "light", dailySyncTime: "08:30", youtubeChannels: ["@Fireship", "@mkbhd"],
  }, null, 2));
}

// ---------- helpers ----------
let srv;
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: p, method,
      headers: { "x-sidekick-token": srv.token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve(s)); });
    req.on("error", reject);
    req.end(data);
  });
}

function waitForDone(count, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const req = http.get({ host: "127.0.0.1", port: PORT, path: `/api/events?t=${srv.token}` }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        seen += (chunk.match(/^event: (done|failure)$/gm) || []).length;
        if (seen >= count) { req.destroy(); resolve(); }
      });
    });
    setTimeout(() => { req.destroy(); reject(new Error("timed out waiting for Claude")); }, timeoutMs);
  });
}

function makeWin(w, h, transparent = true) {
  const win = new BrowserWindow({
    width: w, height: h, x: 40, y: 40, frame: false, transparent, show: false,
    resizable: false, skipTaskbar: true, focusable: true, hasShadow: false,
    backgroundColor: transparent ? "#00000000" : "#ffffff",
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  return win;
}

async function shot(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log("saved", file);
}

const js = (win, code) => win.webContents.executeJavaScript(code);

// Replace anything that looks like an email address, and keep doing it whenever the
// page re-renders (a MutationObserver), so a refresh can't bring the real one back.
const MASK = `(() => {
  const re = /[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g;
  const fix = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const v = n.nodeValue, r = v.replace(re, "you@example.com");
      if (r !== v) n.nodeValue = r;
    }
  };
  fix();
  if (!window.__mask) {
    window.__mask = new MutationObserver(fix);
    window.__mask.observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  return true;
})()`;
// Any email still visible other than the placeholder?
const LEAKS = `(document.body.innerText.match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g) || []).filter((e) => e !== "you@example.com")`;

// The pages strip the token from the URL right after loading, which makes loadURL's
// promise reject even though the page is fine, so wait for did-finish-load instead.
async function load(win, url, wait = 1500) {
  const finished = new Promise((r) => win.webContents.once("did-finish-load", r));
  win.loadURL(url).catch(() => {});
  await Promise.race([finished, sleep(8000)]);
  win.showInactive();
  await sleep(wait);
}

// ---------- run ----------
app.on("window-all-closed", () => {}); // keep running between captures
app.whenReady().then(async () => {
  try {
    seed();
    fs.mkdirSync(OUT, { recursive: true });
    const { startServer } = require(path.join(ROOT, "src", "server.js"));
    srv = await startServer({ dataDir: DATA, port: PORT, openExternal() {}, openPath() {} });
    const base = `http://127.0.0.1:${PORT}`;

    // 1. Mascot moods (demo mode: forced mood, sample data)
    // A fresh window per capture: changing only the #hash wouldn't reload the page.
    async function petShot(demo, file, theme) {
      nativeTheme.themeSource = theme;
      const pet = makeWin(340, 430);
      await load(pet, `${base}/mascot#t=${srv.token}&demo=${demo}`, 1400);
      await shot(pet, file);
      pet.destroy();
    }
    for (const mood of ["idle", "thinking", "fetching", "talking", "alert", "sleeping"]) {
      await petShot(mood, `_mood-${mood}.png`, "light");
    }
    await petShot("notifier", "_notifier-dark.png", "dark");
    await petShot("notifier", "_notifier-light.png", "light");

    // 2. Chat window: task board (light)
    const panel = makeWin(380, 580);
    await load(panel, `${base}/#t=${srv.token}`, 2000);
    await js(panel, `document.getElementById("tabTasks").click()`);
    await sleep(500);
    await shot(panel, "_tasks-light.png");

    // 3. A real conversation through Claude Code, shown in dark
    const done = waitForDone(2);
    await api("POST", "/api/chat", { text: "Remind me in 20 minutes to stretch" });
    await new Promise((r) => setTimeout(r, 100));
    await (async () => {
      // second message once the first finished
      const first = waitForDone(1);
      await first;
      await api("POST", "/api/chat", { text: "What's on my plate today? Keep it short." });
    })();
    await done;
    await api("PATCH", "/api/settings", { theme: "dark" });
    await sleep(1200);
    await js(panel, `document.getElementById("tabChat").click()`);
    await sleep(600);
    await shot(panel, "chat-dark.png");
    await api("PATCH", "/api/settings", { theme: "light" });
    await sleep(800);

    // 4. Settings window
    const set = makeWin(820, 600, false);
    await load(set, `${base}/settings#t=${srv.token}`, 300);
    await js(set, MASK); // before the account info even arrives
    await sleep(5000); // /api/info takes a few seconds
    for (const [tab, theme, file] of [
      ["general", "light", "settings-general.png"],
      ["ai", "light", "settings-ai.png"],
      ["connections", "dark", "settings-connections.png"],
      ["mascot", "dark", "settings-mascot.png"],
    ]) {
      await api("PATCH", "/api/settings", { theme });
      await sleep(900);
      await js(set, `document.getElementById("tab-${tab}").click()`);
      await sleep(900);
      await js(set, MASK);
      await sleep(200);
      const leaks = await js(set, LEAKS);
      if (leaks.length) throw new Error(`refusing to save ${file}: an email address is visible`);
      await shot(set, file);
    }
    await api("PATCH", "/api/settings", { theme: "light" });
    set.destroy();
    panel.destroy();

    // 5. Composites: hero + mood strip + notifier pair
    const WALL = "radial-gradient(1200px 600px at 20% 10%,#cfe6ff,transparent),radial-gradient(900px 600px at 90% 90%,#e3d9ff,transparent),linear-gradient(135deg,#eef5ff,#f5f0ff)";
    const page = (name, w, h, html) => {
      const f = path.join(OUT, `_${name}.html`);
      fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font:600 14px "Segoe UI",sans-serif}
        .wall{position:absolute;inset:0;background:${WALL}}
        .bar{position:absolute;left:0;right:0;bottom:0;height:44px;background:rgba(20,30,50,.72);backdrop-filter:blur(8px)}
        img{position:absolute;display:block}
        .tile{position:relative;display:inline-flex;flex-direction:column;align-items:center;width:170px;margin:0 4px}
        .tile .crop{width:170px;height:175px;background-repeat:no-repeat;background-position:50% 100%}
        .tile span{margin-top:6px;color:#33445a}
      </style>${html}`);
      return f;
    };
    const comp = makeWin(10, 10, false);
    // The mascot is embedded live (iframe) so it's drawn straight onto the backdrop;
    // captures of transparent windows leave a pale box behind the notifier's shadow.
    // color-scheme on the <iframe> must match the page inside it, or Chromium paints an
    // opaque backdrop behind it.
    const petFrame = (left, top, theme) =>
      `<iframe src="${base}/mascot#t=${srv.token}&demo=notifier" style="position:absolute;left:${left}px;top:${top}px;width:320px;height:430px;border:0;background:transparent;color-scheme:${theme}"></iframe>`;
    // frames: [{ theme, left, top }] in DOM order. Each embedded mascot gets the theme and
    // the same backdrop painted inside it, lined up with the page behind it, so its
    // shadows blend onto real colours (no pale box).
    async function render(name, w, h, html, out, frames = []) {
      nativeTheme.themeSource = "light";
      comp.setContentSize(w, h);
      const finished = new Promise((r) => comp.webContents.once("did-finish-load", r));
      comp.loadFile(page(name, w, h, html)).catch(() => {});
      await Promise.race([finished, sleep(8000)]);
      comp.showInactive();
      await sleep(800);
      const sub = comp.webContents.mainFrame.frames;
      for (let i = 0; i < frames.length; i++) {
        const { theme, left, top } = frames[i];
        const css = `html,body{background:${WALL} !important;background-size:${w}px ${h}px !important;` +
          `background-position:-${left}px -${top}px !important;background-repeat:no-repeat !important}`;
        await sub[i]?.executeJavaScript(`(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.append(s);
        })()`);
      }
      await sleep(1000);
      await shot(comp, out);
    }
    // Mascot + notifier captured on an opaque copy of the backdrop, offset so it lines up
    // exactly where it's placed in the composite. insertCSS isn't blocked by the page's CSP.
    async function petOnWall(file, theme, left, top, W, H) {
      nativeTheme.themeSource = theme;
      const w = makeWin(340, 430, false);
      const finished = new Promise((r) => w.webContents.once("did-finish-load", r));
      w.loadURL(`${base}/mascot#t=${srv.token}&demo=notifier`).catch(() => {});
      await Promise.race([finished, sleep(8000)]);
      await w.webContents.insertCSS(`html,body{background:${WALL} !important;background-size:${W}px ${H}px !important;` +
        `background-position:-${left}px -${top}px !important;background-repeat:no-repeat !important}`);
      await js(w, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      w.showInactive();
      await sleep(1600);
      await shot(w, file);
      w.destroy();
    }
    await petOnWall("_pet-hero.png", "dark", 700, 226, 1200, 700);
    await petOnWall("_pet-n1.png", "light", 30, 20, 760, 470);
    await petOnWall("_pet-n2.png", "dark", 390, 20, 760, 470);

    await render("hero", 1200, 700, `<div class="wall"></div><div class="bar"></div>
      <img src="_tasks-light.png" style="left:170px;top:50px;filter:drop-shadow(0 18px 30px rgba(20,40,80,.25))">
      <img src="_pet-hero.png" style="left:700px;top:226px">`, "hero.png");
    const moods = ["idle", "thinking", "fetching", "talking", "alert", "sleeping"];
    const label = { idle: "Idle", thinking: "Handling a request", fetching: "Fetching data", talking: "Answering", alert: "Reminding", sleeping: "Napping" };
    await render("moods", 1120, 250, `<div class="wall"></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      ${moods.map((m) => `<div class="tile"><div class="crop" style="background-image:url('_mood-${m}.png')"></div><span>${label[m]}</span></div>`).join("")}</div>`, "mascot-moods.png");
    await render("notifier", 760, 470, `<div class="wall"></div>
      <img src="_pet-n1.png" style="left:30px;top:20px"><img src="_pet-n2.png" style="left:390px;top:20px">`, "notifier.png");
    comp.destroy();

    // tidy intermediates (keep the task board on its own too)
    fs.copyFileSync(path.join(OUT, "_tasks-light.png"), path.join(OUT, "tasks-light.png"));
    for (const f of fs.readdirSync(OUT)) if (f.startsWith("_")) fs.unlinkSync(path.join(OUT, f));
  } catch (err) {
    console.error("FAILED:", err);
  } finally {
    srv?.close();
    app.exit(0);
  }
});
