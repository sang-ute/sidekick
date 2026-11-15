// The only bridge between the page and Node. The page can't touch the API key or the filesystem.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("sidekick", {
  toggle: () => ipcRenderer.invoke("ui:toggle"),
  collapse: () => ipcRenderer.invoke("ui:collapse"),
  hasKey: () => ipcRenderer.invoke("settings:hasKey"),
  setKey: (key) => ipcRenderer.invoke("settings:setKey", key),
  reset: () => ipcRenderer.invoke("chat:reset"),
  listReminders: () => ipcRenderer.invoke("reminders:list"),
  deleteReminder: (id) => ipcRenderer.invoke("reminders:delete", id),
  send: (text) => ipcRenderer.send("chat:send", text),
  onExpanded: on("ui:expanded"),
  onReminder: on("ui:reminder"),
  onDelta: on("chat:delta"),
  onTool: on("chat:tool"),
  onDone: on("chat:done"),
  onError: on("chat:error"),
});
