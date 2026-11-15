// Tiny JSON persistence in Electron's per-user data folder
// (%APPDATA%\sidekick on Windows). Settings and reminders only, no secrets in plain text.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const file = (name) => path.join(app.getPath("userData"), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const tmp = file(name) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name)); // atomic-ish replace so a crash can't half-write
}

// ---------- settings ----------
const DEFAULT_SETTINGS = { openAtLogin: true, apiKeyEnc: null, bounds: null };

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
}

function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson("settings.json", next);
  return next;
}

// API key is encrypted with Windows DPAPI via Electron safeStorage.
function setApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption unavailable");
  updateSettings({ apiKeyEnc: safeStorage.encryptString(key.trim()).toString("base64") });
}

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const { apiKeyEnc } = getSettings();
  if (!apiKeyEnc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(apiKeyEnc, "base64"));
  } catch {
    return null;
  }
}

// ---------- reminders ----------
// { id, text, dueAt (ISO), repeat: "none"|"daily"|"weekly", createdAt }
const getReminders = () => readJson("reminders.json", []);
const saveReminders = (list) => writeJson("reminders.json", list);

function addReminder({ text, dueAt, repeat = "none" }) {
  const list = getReminders();
  const r = {
    id: Math.random().toString(36).slice(2, 8),
    text,
    dueAt: new Date(dueAt).toISOString(),
    repeat,
    createdAt: new Date().toISOString(),
  };
  list.push(r);
  saveReminders(list);
  return r;
}

function removeReminder(id) {
  const list = getReminders();
  const next = list.filter((r) => r.id !== id);
  saveReminders(next);
  return next.length !== list.length;
}

module.exports = {
  getSettings,
  updateSettings,
  setApiKey,
  getApiKey,
  getReminders,
  saveReminders,
  addReminder,
  removeReminder,
};
