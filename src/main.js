// Electron shell: starts the local server (which connects Claude Code), shows the
// floating bubble, tray icon, global shortcut, native notifications, launch at login.
const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, screen, nativeImage, shell, dialog,
} = require("electron");
const { startServer } = require("./server");

const BUBBLE = { width: 76, height: 76 };
const PANEL = { width: 380, height: 580 };
const MARGIN = 16;
const ICON = path.join(__dirname, "..", "assets", "icon.png");

let win = null;
let tray = null;
let srv = null;
let expanded = false;

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId("com.sidekick.assistant"); // required for Windows toast notifications

// ---------- shell settings (window position, autostart) ----------
const shellFile = () => path.join(app.getPath("userData"), "shell.json");
function getShell() {
  try { return { openAtLogin: true, bounds: null, ...JSON.parse(fs.readFileSync(shellFile(), "utf8")) }; }
  catch { return { openAtLogin: true, bounds: null }; }
}
function setShell(patch) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(shellFile(), JSON.stringify({ ...getShell(), ...patch }, null, 2));
}

// ---------- window ----------
// The bottom-right corner is the anchor: the bubble sits there, the panel grows up-left from it.
function anchor() {
  const saved = getShell().bounds;
  const wa = screen.getPrimaryDisplay().workArea;
  if (saved && saved.right <= wa.x + wa.width + 50 && saved.bottom <= wa.y + wa.height + 50) return saved;
  return { right: wa.x + wa.width - MARGIN, bottom: wa.y + wa.height - MARGIN };
}
function boundsFor(size) {
  const { right, bottom } = anchor();
  return { x: right - size.width, y: bottom - size.height, ...size };
}

function createWindow(url) {
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
  win.loadURL(url);
  win.once("ready-to-show", () => win.showInactive());
  // Links Claude writes open in the real browser, never inside the bubble.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(`http://127.0.0.1:${srv.port}/`)) e.preventDefault();
  });
  win.on("moved", () => {
    const b = win.getBounds();
    setShell({ bounds: { right: b.x + b.width, bottom: b.y + b.height } });
  });
}

function setExpanded(next) {
  expanded = next;
  if (!win.isVisible()) win.showInactive();
  win.setBounds(boundsFor(expanded ? PANEL : BUBBLE));
  win.webContents.send("shell:expanded", expanded);
  if (expanded) win.focus();
}
const toggle = () => setExpanded(!expanded);

// ---------- tray ----------
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open Sidekick", click: () => setExpanded(true) },
    { label: "Open in browser", click: () => shell.openExternal(srv.url) },
    { label: "Hide bubble", click: () => win.hide() },
    { label: "Show bubble", click: () => win.showInactive() },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: getShell().openAtLogin,
      click: (item) => { setShell({ openAtLogin: item.checked }); applyLoginItem(); },
    },
    { label: "Reset position", click: () => { setShell({ bounds: null }); setExpanded(expanded); } },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function applyLoginItem() {
  const openAtLogin = getShell().openAtLogin;
  // From source, electron.exe needs the app folder as an argument; an installed build doesn't.
  app.setLoginItemSettings(
    app.isPackaged
      ? { openAtLogin }
      : { openAtLogin, path: process.execPath, args: [path.resolve(__dirname, "..")] },
  );
}

// ---------- IPC (window controls only; chat goes through the local server) ----------
ipcMain.handle("shell:toggle", () => toggle());
ipcMain.handle("shell:collapse", () => setExpanded(false));

// ---------- lifecycle ----------
app.on("second-instance", () => setExpanded(true));
app.whenReady().then(async () => {
  try {
    srv = await startServer({ dataDir: app.getPath("userData") });
  } catch (err) {
    dialog.showErrorBox("Sidekick", err.code === "EADDRINUSE"
      ? "Port 47821 is busy. Is Sidekick already running (maybe via `npm run server`)?"
      : String(err));
    return app.exit(1);
  }

  srv.events.on("reminder", (r) => {
    const n = new Notification({ title: "Sidekick reminder", body: r.text, icon: ICON });
    n.on("click", () => setExpanded(true));
    n.show();
  });

  createWindow(srv.url);
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Sidekick (Ctrl+Shift+Space)");
  tray.setContextMenu(trayMenu());
  tray.on("click", toggle);
  globalShortcut.register("Control+Shift+Space", toggle);

  // SIDEKICK_SMOKE=<png path>: open the panel, screenshot it, quit (for testing).
  if (process.env.SIDEKICK_SMOKE) {
    win.webContents.once("did-finish-load", () => {
      setExpanded(true);
      setTimeout(async () => {
        fs.writeFileSync(process.env.SIDEKICK_SMOKE, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.SIDEKICK_SMOKE_WAIT) || 2000);
    });
    return;
  }
  applyLoginItem();
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); srv?.close(); });
app.on("window-all-closed", (e) => e.preventDefault()); // keep living in the tray
