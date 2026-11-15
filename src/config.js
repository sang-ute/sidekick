// Sidekick settings: defaults, choices shown in the settings dashboard, and validation.
// Stored in <dataDir>/config.json. The server owns it; the Electron shell and the MCP
// server read it.
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  // AI
  model: null, // null = Claude Code's default
  effort: "low",
  responseStyle: "balanced",
  language: "", // "" = reply in the user's language
  // Connections
  integrations: { github: true, youtube: true, gmail: true, calendar: true, web: true },
  mcpServers: {}, // name -> { type: "stdio", command, args, env } | { type: "http", url, headers }
  extraAllowedTools: [],
  youtubeChannels: [],
  // Schedule
  dailySyncTime: "08:30",
  // Appearance & behaviour (applied by the desktop shell)
  theme: "system",
  openAtLogin: true,
  mascotVisible: true,
  mascotSize: "medium",
  sleepAfterMinutes: 10,
  notifier: { autoShow: true, hideAfterSeconds: 12 },
  shortcut: "Control+Shift+Space",
};

const OPTIONS = {
  models: [
    { id: null, label: "Default", note: "Whatever Claude Code is set to use" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Smart all-rounder" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast and capable" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, lightest on usage" },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2", note: "Most capable, heaviest on usage; may need a higher plan" },
  ],
  efforts: [
    { id: "low", label: "Low", hint: "Quick answers, lightest on usage" },
    { id: "medium", label: "Medium", hint: "A bit more thought" },
    { id: "high", label: "High", hint: "Thinks things through" },
    { id: "xhigh", label: "Extra high", hint: "Deep reasoning, slower" },
    { id: "max", label: "Max", hint: "Maximum effort, slowest and heaviest" },
  ],
  responseStyles: [
    { id: "brief", label: "Brief", hint: "One to three short lines" },
    { id: "balanced", label: "Balanced", hint: "Short, with detail when it helps" },
    { id: "detailed", label: "Detailed", hint: "Full explanations and steps" },
  ],
  themes: ["system", "light", "dark"],
  mascotSizes: ["small", "medium", "large"],
};

// Changing any of these restarts the Claude Code session.
const AI_KEYS = ["model", "effort", "responseStyle", "language", "integrations", "mcpServers", "extraAllowedTools"];

const file = (dataDir) => path.join(dataDir, "config.json");
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function load(dataDir) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(dataDir), "utf8")); } catch {}
  const cfg = { ...DEFAULTS, ...saved };
  cfg.integrations = { ...DEFAULTS.integrations, ...(isObj(saved.integrations) ? saved.integrations : {}) };
  cfg.notifier = { ...DEFAULTS.notifier, ...(isObj(saved.notifier) ? saved.notifier : {}) };
  return cfg;
}

function save(dataDir, cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file(dataDir));
}

// ---------- validation ----------
function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }
const oneOf = (v, list, name) => (list.includes(v) ? v : bad(`${name} must be one of: ${list.join(", ")}`));
const bool = (v, name) => (typeof v === "boolean" ? v : bad(`${name} must be true or false`));
function int(v, min, max, name) {
  if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}
function strList(v, name, { max = 50, re = /^.{1,100}$/ } = {}) {
  if (!Array.isArray(v) || v.length > max) bad(`${name} must be a list of up to ${max} items`);
  return [...new Set(v.map((s) => {
    if (typeof s !== "string" || !re.test(s.trim())) bad(`${name}: "${String(s).slice(0, 40)}" isn't allowed`);
    return s.trim();
  }))];
}
function strMap(v, name, keyRe) {
  if (v === undefined) return {};
  if (!isObj(v)) bad(`${name} must be KEY=VALUE pairs`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!keyRe.test(k) || typeof val !== "string" || val.length > 2000) bad(`${name}: bad entry "${k}"`);
    out[k] = val;
  }
  return out;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
function mcpServers(v) {
  if (!isObj(v)) bad("mcpServers must be an object");
  const names = Object.keys(v);
  if (names.length > 20) bad("At most 20 custom MCP servers");
  const out = {};
  for (const name of names) {
    if (!SERVER_NAME.test(name)) bad(`MCP server name "${name}" can only use letters, numbers, - and _`);
    if (name.toLowerCase() === "sidekick") bad(`"sidekick" is reserved for the built-in tools`);
    const s = v[name];
    if (!isObj(s)) bad(`MCP server "${name}" is invalid`);
    if (s.type === "http") {
      if (typeof s.url !== "string" || !/^https?:\/\/\S{3,500}$/.test(s.url)) bad(`MCP server "${name}" needs an http(s) URL`);
      out[name] = { type: "http", url: s.url, headers: strMap(s.headers, `${name} headers`, /^[A-Za-z0-9-]{1,80}$/) };
    } else if (s.type === "stdio" || s.type === undefined) {
      if (typeof s.command !== "string" || !s.command.trim() || s.command.length > 300) bad(`MCP server "${name}" needs a command`);
      const args = s.args === undefined ? [] : s.args;
      if (!Array.isArray(args) || args.length > 50 || args.some((a) => typeof a !== "string" || a.length > 500)) {
        bad(`MCP server "${name}" has invalid arguments`);
      }
      out[name] = { type: "stdio", command: s.command.trim(), args, env: strMap(s.env, `${name} env`, /^[A-Za-z_][A-Za-z0-9_]{0,80}$/) };
    } else {
      bad(`MCP server "${name}": type must be stdio or http`);
    }
  }
  return out;
}

const ACCEL_PART = /^(Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|Shift|Super|Meta|[A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Escape|Esc)$/i;

/** Returns a cleaned copy of a partial config, or throws an Error with .status 400. */
function validatePatch(patch, current) {
  if (!isObj(patch)) bad("Settings must be an object");
  const out = {};
  for (const [key, v] of Object.entries(patch)) {
    switch (key) {
      case "model":
        out.model = v === null || v === "" ? null
          : typeof v === "string" && /^[A-Za-z0-9.\-[\]]{2,60}$/.test(v) ? v : bad("model is not a valid model name");
        break;
      case "effort": out.effort = oneOf(v, OPTIONS.efforts.map((e) => e.id), "effort"); break;
      case "responseStyle": out.responseStyle = oneOf(v, OPTIONS.responseStyles.map((e) => e.id), "responseStyle"); break;
      case "language":
        out.language = typeof v === "string" && /^[\p{L} ()'-]{0,40}$/u.test(v) ? v.trim() : bad("language should be a language name, like Vietnamese");
        break;
      case "integrations": {
        if (!isObj(v)) bad("integrations must be an object");
        const merged = { ...current.integrations };
        for (const k of Object.keys(DEFAULTS.integrations)) if (k in v) merged[k] = bool(v[k], `integrations.${k}`);
        out.integrations = merged;
        break;
      }
      case "mcpServers": out.mcpServers = mcpServers(v); break;
      case "extraAllowedTools":
        out.extraAllowedTools = strList(v, "extraAllowedTools", { re: /^[A-Za-z0-9_*().:\- ]{1,100}$/ });
        break;
      case "youtubeChannels":
        out.youtubeChannels = strList(v, "youtubeChannels", { re: /^[^\s"'<>]{2,100}$/ });
        break;
      case "dailySyncTime":
        out.dailySyncTime = v === null || v === "" ? null
          : typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : bad("dailySyncTime must look like 08:30");
        break;
      case "theme": out.theme = oneOf(v, OPTIONS.themes, "theme"); break;
      case "openAtLogin": out.openAtLogin = bool(v, key); break;
      case "mascotVisible": out.mascotVisible = bool(v, key); break;
      case "mascotSize": out.mascotSize = oneOf(v, OPTIONS.mascotSizes, "mascotSize"); break;
      case "sleepAfterMinutes": out.sleepAfterMinutes = int(v, 0, 240, "sleepAfterMinutes"); break;
      case "notifier": {
        if (!isObj(v)) bad("notifier must be an object");
        const n = { ...current.notifier };
        if ("autoShow" in v) n.autoShow = bool(v.autoShow, "notifier.autoShow");
        if ("hideAfterSeconds" in v) n.hideAfterSeconds = int(v.hideAfterSeconds, 3, 120, "notifier.hideAfterSeconds");
        out.notifier = n;
        break;
      }
      case "shortcut": {
        const parts = typeof v === "string" ? v.split("+").map((p) => p.trim()) : [];
        if (parts.length < 2 || parts.length > 4 || !parts.every((p) => ACCEL_PART.test(p))) {
          bad('shortcut should look like "Control+Shift+Space"');
        }
        out.shortcut = parts.join("+");
        break;
      }
      default:
        bad(`Unknown setting "${key}"`);
    }
  }
  return out;
}

module.exports = { DEFAULTS, OPTIONS, AI_KEYS, load, save, validatePatch };
