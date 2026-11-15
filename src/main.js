// Electron shell: starts the local server (which connects Claude Code), shows the
// desktop mascot and the chat window, tray icon, shortcut, notifications, autostart.
const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, screen, nativeImage, shell, dialog,
} = require("electron");
const { startServer } = require("./server");

const PET = { width: 230, height: 240 }; // pet + room for its speech bubble
const PANEL = { width: 380, height: 580 };
const ICON = path.join(__dirname, "..", "assets", "icon.png");

let pet = null;
let panel = null;
let tray = null;
let srv = null;
let dragOrigin = null;

if (process.env.SIDEKICK_DATA_DIR) app.setPath("userData", process.env.SIDEKICK_DATA_DIR); // testing
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId("com.sidekick.assistant"); // needed for Windows toast notifications

// ---------- shell settings ----------
const shellFile = () => path.join(app.getPath("userData"), "shell.json");
const DEFAULTS = { openAtLogin: true, petPos: null, petVisible: true };
function getShell() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(shellFile(), "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function setShell(patch) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(shellFile(), JSON.stringify({ ...getShell(), ...patch }, null, 2));
}

const webPreferences = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function lockDown(win) {
  // Links open in the real browser; the windows never navigate away from the local UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${srv.port}/`)) e.preventDefault();
  });
}

// ---------- mascot window ----------
function petStartPos() {
  const saved = getShell().petPos;
  if (saved) {
    const wa = screen.getDisplayNearestPoint(saved).workArea;
    const onScreen = saved.x > wa.x - PET.width / 2 && saved.x < wa.x + wa.width - PET.width / 2 &&
      saved.y > wa.y - PET.height / 2 && saved.y < wa.y + wa.height - PET.height / 2;
    if (onScreen) return saved;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - PET.width - 10, y: wa.y + wa.height - PET.height };
}

function createPet() {
  pet = new BrowserWindow({
    ...petStartPos(), ...PET,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    icon: ICON, webPreferences,
  });
  pet.setAlwaysOnTop(true, "floating");
  pet.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through except on the pet itself
  pet.loadURL(`http://127.0.0.1:${srv.port}/mascot#t=${srv.token}`);
  pet.once("ready-to-show", () => { if (getShell().petVisible) pet.showInactive(); });
  lockDown(pet);
}

// Eyes follow the cursor: send its offset from the pet's face ~12 times a second.
let lastCursor = "";
setInterval(() => {
  if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = pet.getBounds();
  const msg = { dx: p.x - (b.x + b.width / 2), dy: p.y - (b.y + b.height - 66) };
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
  let x = b.x - PANEL.width + 30;
  if (x < wa.x) x = b.x + b.width - 30;
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

// ---------- menus ----------
function menuTemplate() {
  return [
    { label: "Chat", click: openPanel },
    { label: "Open in browser", click: () => shell.openExternal(srv.url) },
    { type: "separator" },
    {
      label: "Show mascot", type: "checkbox", checked: pet?.isVisible() ?? true,
      click: (i) => { setShell({ petVisible: i.checked }); i.checked ? pet.showInactive() : (pet.hide(), closePanel()); },
    },
    { label: "Reset mascot position", click: () => { setShell({ petPos: null }); pet.setPosition(petStartPos().x, petStartPos().y); } },
    {
      label: "Start with Windows", type: "checkbox", checked: getShell().openAtLogin,
      click: (i) => { setShell({ openAtLogin: i.checked }); applyLoginItem(); },
    },
    { label: "Open data folder", click: () => shell.openPath(app.getPath("userData")) },
    { type: "separator" },
    { label: "Quit Sidekick", click: () => app.quit() },
  ];
}

function applyLoginItem() {
  const openAtLogin = getShell().openAtLogin;
  // Installed: launch the exe. From source: electron.exe needs the app folder argument.
  app.setLoginItemSettings(
    app.isPackaged
      ? { openAtLogin }
      : { openAtLogin, path: process.execPath, args: [path.resolve(__dirname, "..")] },
  );
}

// ---------- IPC ----------
ipcMain.on("panel:toggle", togglePanel);
ipcMain.on("panel:open", openPanel);
ipcMain.on("panel:close", closePanel);
ipcMain.on("pet:interactive", (_e, on) => pet.setIgnoreMouseEvents(!on, { forward: true }));
ipcMain.on("pet:menu", () => Menu.buildFromTemplate(menuTemplate()).popup({ window: pet }));
ipcMain.on("pet:dragStart", () => { dragOrigin = pet.getPosition(); });
ipcMain.on("pet:dragMove", (_e, dx, dy) => {
  if (!dragOrigin || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  pet.setBounds({ x: Math.round(dragOrigin[0] + dx), y: Math.round(dragOrigin[1] + dy), ...PET });
  if (panel.isVisible()) placePanel();
});
ipcMain.on("pet:dragEnd", () => {
  dragOrigin = null;
  const [x, y] = pet.getPosition();
  setShell({ petPos: { x, y } });
});

// ---------- lifecycle ----------
app.on("second-instance", openPanel);
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
    n.on("click", openPanel);
    n.show();
  });

  createPet();
  createPanel();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Sidekick (Ctrl+Shift+Space)");
  tray.on("click", togglePanel);
  tray.on("right-click", () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
  globalShortcut.register("Control+Shift+Space", togglePanel);

  // SIDEKICK_SMOKE=<png path>: screenshot the mascot (and chat if SIDEKICK_SMOKE_PANEL), then quit.
  if (process.env.SIDEKICK_SMOKE) {
    pet.webContents.once("did-finish-load", () => {
      if (process.env.SIDEKICK_SMOKE_PANEL) setTimeout(openPanel, 300);
      setTimeout(async () => {
        const out = process.env.SIDEKICK_SMOKE;
        fs.writeFileSync(out, (await pet.webContents.capturePage()).toPNG());
        if (process.env.SIDEKICK_SMOKE_PANEL) {
          fs.writeFileSync(out.replace(/\.png$/, "-panel.png"), (await panel.webContents.capturePage()).toPNG());
        }
        app.quit();
      }, Number(process.env.SIDEKICK_SMOKE_WAIT) || 2500);
    });
    return;
  }
  applyLoginItem();
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); srv?.close(); });
app.on("window-all-closed", (e) => e.preventDefault()); // keep living in the tray
