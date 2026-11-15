// Electron main process: floating bubble window, tray, global shortcut,
// launch-at-login, and the reminder scheduler.
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, screen, nativeImage,
} = require("electron");
const store = require("./store");
const { Agent } = require("./agent");

const BUBBLE = { width: 76, height: 76 };
const PANEL = { width: 380, height: 580 };
const MARGIN = 16;
const ICON = path.join(__dirname, "..", "assets", "icon.png");

let win = null;
let tray = null;
let expanded = false;
const agent = new Agent();

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.sidekick.assistant"); // required for Windows toast notifications

// ---------- window ----------
// The window's bottom-right corner is its anchor: the bubble sits there and
// the panel grows up and to the left from it.
function anchor() {
  const saved = store.getSettings().bounds;
  if (saved) return saved;
  const wa = screen.getPrimaryDisplay().workArea;
  return { right: wa.x + wa.width - MARGIN, bottom: wa.y + wa.height - MARGIN };
}

function boundsFor(size) {
  const { right, bottom } = anchor();
  return { x: right - size.width, y: bottom - size.height, ...size };
}

function createWindow() {
  win = new BrowserWindow({
    ...boundsFor(BUBBLE),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.showInactive());

  // Remember where the user dragged the panel (by its bottom-right corner).
  win.on("moved", () => {
    const b = win.getBounds();
    store.updateSettings({ bounds: { right: b.x + b.width, bottom: b.y + b.height } });
  });
}

function setExpanded(next) {
  expanded = next;
  win.setBounds(boundsFor(expanded ? PANEL : BUBBLE));
  win.webContents.send("ui:expanded", expanded);
  if (expanded) win.focus();
}

function toggle() {
  if (!win.isVisible()) win.showInactive();
  setExpanded(!expanded);
}

// ---------- tray ----------
function buildTrayMenu() {
  const s = store.getSettings();
  return Menu.buildFromTemplate([
    { label: "Open Sidekick", click: () => setExpanded(true) },
    { label: "Hide bubble", click: () => win.hide() },
    { label: "Show bubble", click: () => win.showInactive() },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: s.openAtLogin,
      click: (item) => {
        store.updateSettings({ openAtLogin: item.checked });
        applyLoginItem();
      },
    },
    { label: "Reset position", click: () => { store.updateSettings({ bounds: null }); setExpanded(expanded); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Sidekick (Ctrl+Shift+Space)");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggle);
}

function applyLoginItem() {
  const openAtLogin = store.getSettings().openAtLogin;
  // In dev, electron.exe needs the app folder as an argument; packaged builds don't.
  const opts = app.isPackaged
    ? { openAtLogin }
    : { openAtLogin, path: process.execPath, args: [path.resolve(__dirname, "..")] };
  app.setLoginItemSettings(opts);
}

// ---------- reminders ----------
function nextOccurrence(r) {
  const step = r.repeat === "daily" ? 864e5 : 7 * 864e5;
  let t = new Date(r.dueAt).getTime();
  while (t <= Date.now()) t += step; // skip occurrences missed while the PC was off
  return new Date(t).toISOString();
}

function checkReminders() {
  const now = Date.now();
  const list = store.getReminders();
  let changed = false;
  const keep = [];
  for (const r of list) {
    if (new Date(r.dueAt).getTime() > now) { keep.push(r); continue; }
    changed = true;
    const n = new Notification({ title: "Sidekick reminder", body: r.text, icon: ICON });
    n.on("click", () => setExpanded(true));
    n.show();
    win?.webContents.send("ui:reminder", r);
    if (r.repeat === "daily" || r.repeat === "weekly") keep.push({ ...r, dueAt: nextOccurrence(r) });
  }
  if (changed) store.saveReminders(keep);
}

// ---------- IPC ----------
ipcMain.handle("ui:toggle", () => toggle());
ipcMain.handle("ui:collapse", () => setExpanded(false));
ipcMain.handle("settings:hasKey", () => Boolean(store.getApiKey()));
ipcMain.handle("settings:setKey", (_e, key) => {
  if (typeof key !== "string" || !key.trim().startsWith("sk-ant-")) {
    throw new Error("That doesn't look like an Anthropic API key (sk-ant-…)");
  }
  store.setApiKey(key);
  return true;
});
ipcMain.handle("chat:reset", () => agent.reset());
ipcMain.handle("reminders:list", () => store.getReminders());
ipcMain.handle("reminders:delete", (_e, id) => store.removeReminder(String(id)));
ipcMain.on("chat:send", (e, text) => {
  if (typeof text !== "string" || !text.trim()) return;
  const send = (ch, ...a) => !e.sender.isDestroyed() && e.sender.send(ch, ...a);
  agent.send(text.trim(), {
    delta: (t) => send("chat:delta", t),
    tool: (name) => send("chat:tool", name),
    done: () => send("chat:done"),
    error: (msg) => send("chat:error", msg),
  });
});

// ---------- lifecycle ----------
app.on("second-instance", () => setExpanded(true));
app.whenReady().then(() => {
  createWindow();
  createTray();
  // SIDEKICK_SMOKE=<png path>: open the panel, screenshot it, quit (used for testing).
  if (process.env.SIDEKICK_SMOKE) {
    win.webContents.once("did-finish-load", () => {
      setExpanded(true);
      setTimeout(async () => {
        require("fs").writeFileSync(process.env.SIDEKICK_SMOKE, (await win.webContents.capturePage()).toPNG());
        app.exit(0);
      }, 1500);
    });
    return;
  }
  applyLoginItem();
  globalShortcut.register("Control+Shift+Space", toggle);
  checkReminders();
  setInterval(checkReminders, 15_000);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", (e) => e.preventDefault()); // live in the tray
