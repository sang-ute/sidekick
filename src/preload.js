// Only window controls cross this bridge. Chat goes to the local server over HTTP,
// so the same UI also works in a normal browser tab.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, v) => fn(v));

contextBridge.exposeInMainWorld("sidekickShell", {
  // chat window
  togglePanel: () => ipcRenderer.send("panel:toggle"),
  openPanel: () => ipcRenderer.send("panel:open"),
  closePanel: () => ipcRenderer.send("panel:close"),
  onPanel: on("panel:state"),
  // mascot
  dragStart: () => ipcRenderer.send("pet:dragStart"),
  dragMove: (dx, dy) => ipcRenderer.send("pet:dragMove", Number(dx), Number(dy)),
  dragEnd: () => ipcRenderer.send("pet:dragEnd"),
  setInteractive: (on_) => ipcRenderer.send("pet:interactive", Boolean(on_)),
  showMenu: () => ipcRenderer.send("pet:menu"),
  onCursor: on("pet:cursor"),
});
