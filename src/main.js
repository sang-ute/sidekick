// Electron shell: starts the local server (which connects Claude Code), shows the
// desktop mascot, the chat window and the settings window, tray icon, shortcut,
// notifications, theme, launch at login. Settings live in the server (config.json);
// the shell applies the parts that are about windows.
const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, screen, nativeImage, shell, dialog, nativeTheme,
} = require("electron");
const { startServer } = require("./server");

const PANEL = { width: 380, height: 580 };
const SETTINGS = { width: 820, height: 600 };
const SCALE = { small: 0.8, medium: 1, large: 1.25 };
const ICON = path.join(__dirname, "..", "assets", "icon.png");

let pet = null;
let panel = null;
let settingsWin = null;
let tray = null;
let srv = null;
let dragOrigin = null;
let shortcut = null;

if (process.env.SIDEKICK_DATA_DIR) app.setPath("userData", process.env.SIDEKICK_DATA_DIR); // testing
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId("com.sidekick.assistant"); // needed for Windows toast notifications

const cfg = () => srv.getConfig();

// Mascot window: pet at the bottom-centre, notifier card in the space above it.
function petSize() {
  const s = SCALE[cfg().mascotSize] || 1;
  return { width: 320, height: 300 + Math.round(130 * s) };
}

// ---------- window state (position only; settings are in config.json) ----------
const stateFile = () => path.join(app.getPath("userData"), "shell.json");
function getState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function setState(patch) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ ...getState(), ...patch }, null, 2));
}

const webPreferences = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function lockDown(win) {
  // Links open in the real browser; windows never navigate away from the local UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${srv.port}/`)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${srv.port}/`)) e.preventDefault();
  });
}

// ---------- mascot window ----------
// The pet's feet are the anchor: { cx, bottom } in screen coordinates.
function petAnchor() {
  const st = getState();
  let a = st.petAnchor;
  if (!a && st.petPos) a = { cx: st.petPos.x + 115, bottom: st.petPos.y + 240 }; // older versions
  if (a) {
    const wa = screen.getDisplayNearestPoint({ x: Math.round(a.cx), y: Math.round(a.bottom) - 50 }).workArea;
    if (a.cx > wa.x && a.cx < wa.x + wa.width && a.bottom > wa.y + 100 && a.bottom <= wa.y + wa.height + 20) return a;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { cx: wa.x + wa.width - 170, bottom: wa.y + wa.height };
}
function petBounds(anchor = petAnchor()) {
  const size = petSize();
  return { x: Math.round(anchor.cx - size.width / 2), y: Math.round(anchor.bottom - size.height), ...size };
}

function demoHash() {
  const d = process.env.SIDEKICK_MASCOT_DEMO;
  return d && /^[a-z]+$/.test(d) ? `&demo=${d}` : "";
}

function createPet() {
  pet = new BrowserWindow({
    ...petBounds(),
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    icon: ICON, webPreferences,
  });
  pet.setAlwaysOnTop(true, "floating");
  pet.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through except on the pet and notifier
  pet.loadURL(`http://127.0.0.1:${srv.port}/mascot#t=${srv.token}${demoHash()}`);
  pet.once("ready-to-show", () => { if (cfg().mascotVisible) pet.showInactive(); });
  lockDown(pet);
}

// Eyes follow the cursor: send its offset from the pet's face ~12 times a second.
let lastCursor = "";
setInterval(() => {
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = pet.getBounds();
  const s = SCALE[cfg().mascotSize] || 1;
  const msg = { dx: p.x - (b.x + b.width / 2), dy: p.y - (b.y + b.height - 66 * s) };
  const key = `${msg.dx},${msg.dy}`;
  if (key !== lastCursor) { lastCursor = key; pet.webContents.send("pet:cursor", msg); }
}, 80);

// ---------- chat window ----------
function createPanel() {
  panel = new BrowserWindow({
    ...PANEL,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, show: false,
    icon: ICON, webPreferences,
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.loadURL(`http://127.0.0.1:${srv.port}/#t=${srv.token}`);
  panel.on("show", () => broadcastPanel(true));
  panel.on("hide", () => broadcastPanel(false));
  lockDown(panel);
}

function broadcastPanel(open) {
  for (const w of [pet, panel]) if (w && !w.isDestroyed()) w.webContents.send("panel:state", open);
}

// Put the chat beside the pet (left if there's room, else right), inside the screen.
function placePanel() {
  const b = pet.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let x = b.x + b.width / 2 - PANEL.width - 50;
  if (x < wa.x) x = b.x + b.width / 2 + 50;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - PANEL.width));
  const y = Math.max(wa.y, Math.min(b.y + b.height - PANEL.height, wa.y + wa.height - PANEL.height));
  panel.setBounds({ x: Math.round(x), y: Math.round(y), ...PANEL });
}

function openPanel() {
  if (!pet.isVisible()) pet.showInactive();
  placePanel();
  panel.show();
  panel.focus();
}
const closePanel = () => panel.hide();
const togglePanel = () => (panel.isVisible() ? closePanel() : openPanel());

// ---------- settings window ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    ...SETTINGS,
    minWidth: 520, minHeight: 420,
    frame: false, show: false, title: "Sidekick settings",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14171c" : "#f7f8fa",
    icon: ICON, webPreferences,
  });
  settingsWin.loadURL(`http://127.0.0.1:${srv.port}/settings#t=${srv.token}`);
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => { settingsWin = null; });
  lockDown(settingsWin);
}
const closeSettings = () => settingsWin?.close();

// ---------- applying settings ----------
let applied = {};
function applyConfig(c) {
  nativeTheme.themeSource = c.theme === "light" || c.theme === "dark" ? c.theme : "system";

  if (applied.openAtLogin !== c.openAtLogin && !process.env.SIDEKICK_SMOKE) {
    // Installed: launch the exe. From source: electron.exe needs the app folder argument.
    app.setLoginItemSettings(app.isPackaged
      ? { openAtLogin: c.openAtLogin }
      : { openAtLogin: c.openAtLogin, path: process.execPath, args: [path.resolve(__dirname, "..")] });
  }

  if (pet && !pet.isDestroyed()) {
    if (applied.mascotSize !== undefined && applied.mascotSize !== c.mascotSize) {
      const b = pet.getBounds();
      pet.setBounds(petBounds({ cx: b.x + b.width / 2, bottom: b.y + b.height }));
      if (panel.isVisible()) placePanel();
    }
    if (c.mascotVisible && !pet.isVisible()) pet.showInactive();
    if (!c.mascotVisible && pet.isVisible()) { pet.hide(); closePanel(); }
  }

  if (applied.shortcut !== c.shortcut) {
    if (shortcut) globalShortcut.unregister(shortcut);
    shortcut = null;
    try {
      if (globalShortcut.register(c.shortcut, togglePanel)) shortcut = c.shortcut;
    } catch {}
    if (!shortcut) console.warn(`Couldn't register shortcut ${c.shortcut}`);
  }

  tray?.setToolTip(`Sidekick${shortcut ? ` (${shortcut})` : ""}`);
  applied = { ...c };
}

// ---------- menus ----------
function menuTemplate() {
  return [
    { label: "Chat", click: openPanel },
    { label: "Settings…", click: openSettings },
    { label: "Open in browser", click: () => shell.openExternal(srv.url) },
    { type: "separator" },
    {
      label: "Show mascot", type: "checkbox", checked: cfg().mascotVisible,
      click: (i) => patchConfig({ mascotVisible: i.checked }),
    },
    {
      label: "Reset mascot position",
      click: () => { setState({ petAnchor: null, petPos: null }); pet.setBounds(petBounds()); },
    },
    {
      label: "Start with Windows", type: "checkbox", checked: cfg().openAtLogin,
      click: (i) => patchConfig({ openAtLogin: i.checked }),
    },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
    { type: "separator" },
    { label: "Quit Sidekick", click: () => app.quit() },
  ];
}

// Menu toggles go through the server so the settings window and config.json stay in sync.
function patchConfig(patch) {
  const http = require("http");
  const body = JSON.stringify(patch);
  const req = http.request({
    host: "127.0.0.1", port: srv.port, path: "/api/settings", method: "PATCH",
    headers: { "Content-Type": "application/json", "x-sidekick-token": srv.token, "Content-Length": Buffer.byteLength(body) },
  });
  req.on("error", () => {});
  req.end(body);
}

// ---------- IPC ----------
ipcMain.on("panel:toggle", togglePanel);
ipcMain.on("panel:open", openPanel);
ipcMain.on("panel:close", closePanel);
ipcMain.on("settings:open", openSettings);
ipcMain.on("settings:close", closeSettings);
ipcMain.on("pet:interactive", (_e, on) => pet.setIgnoreMouseEvents(!on, { forward: true }));
ipcMain.on("pet:menu", () => Menu.buildFromTemplate(menuTemplate()).popup({ window: pet }));
ipcMain.on("pet:dragStart", () => { dragOrigin = pet.getPosition(); });
ipcMain.on("pet:dragMove", (_e, dx, dy) => {
  if (!dragOrigin || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  pet.setBounds({ x: Math.round(dragOrigin[0] + dx), y: Math.round(dragOrigin[1] + dy), ...petSize() });
  if (panel.isVisible()) placePanel();
});
ipcMain.on("pet:dragEnd", () => {
  dragOrigin = null;
  const b = pet.getBounds();
  setState({ petAnchor: { cx: b.x + b.width / 2, bottom: b.y + b.height }, petPos: null });
});

// ---------- lifecycle ----------
app.on("second-instance", openPanel);
app.whenReady().then(async () => {
  try {
    srv = await startServer({
      dataDir: app.getPath("userData"),
      openExternal: (url) => shell.openExternal(url),
      openPath: (p) => shell.openPath(p),
    });
  } catch (err) {
    dialog.showErrorBox("Sidekick", err.code === "EADDRINUSE"
      ? "Port 47821 is busy. Is Sidekick already running (maybe via `npm run server`)?"
      : String(err));
    return app.exit(1);
  }

  srv.events.on("reminder", (r) => {
    const n = new Notification({ title: "Sidekick reminder", body: r.text, icon: ICON });
    n.on("click", openPanel);
    n.show();
  });
  srv.events.on("config", applyConfig);

  nativeTheme.themeSource = ["light", "dark"].includes(cfg().theme) ? cfg().theme : "system";
  createPet();
  createPanel();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", togglePanel);
  tray.on("right-click", () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
  applyConfig(cfg());

  // Screenshot test mode:
  //   SIDEKICK_SMOKE=<png>          mascot window
  //   SIDEKICK_SMOKE_PANEL=1        also the chat window   (<png>-panel.png)
  //   SIDEKICK_SMOKE_SETTINGS=1     also the settings window (<png>-settings.png)
  if (process.env.SIDEKICK_SMOKE) {
    const out = process.env.SIDEKICK_SMOKE;
    pet.webContents.once("did-finish-load", () => {
      if (process.env.SIDEKICK_SMOKE_PANEL) setTimeout(openPanel, 300);
      if (process.env.SIDEKICK_SMOKE_SETTINGS) setTimeout(openSettings, 300);
      setTimeout(async () => {
        fs.writeFileSync(out, (await pet.webContents.capturePage()).toPNG());
        if (process.env.SIDEKICK_SMOKE_PANEL) {
          fs.writeFileSync(out.replace(/\.png$/, "-panel.png"), (await panel.webContents.capturePage()).toPNG());
        }
        if (process.env.SIDEKICK_SMOKE_SETTINGS && settingsWin) {
          fs.writeFileSync(out.replace(/\.png$/, "-settings.png"), (await settingsWin.webContents.capturePage()).toPNG());
        }
        app.quit();
      }, Number(process.env.SIDEKICK_SMOKE_WAIT) || 2500);
    });
  }
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); srv?.close(); });
app.on("window-all-closed", (e) => e.preventDefault()); // keep living in the tray
