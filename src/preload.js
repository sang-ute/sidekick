// Only window controls cross this bridge. Chat talks to the local server over HTTP,
// so the same UI also works in a normal browser tab.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sidekickShell", {
  toggle: () => ipcRenderer.invoke("shell:toggle"),
  collapse: () => ipcRenderer.invoke("shell:collapse"),
  onExpanded: (fn) => ipcRenderer.on("shell:expanded", (_e, v) => fn(v)),
});
