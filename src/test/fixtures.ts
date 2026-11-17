// Sample data shaped like what the Rust core sends.
import type { Config, Hello, Info, Options, Reminder, SidekickNotification, Task } from "../lib/types";

export const config = (over: Partial<Config> = {}): Config => ({
  model: null,
  effort: "low",
  responseStyle: "balanced",
  language: "",
  integrations: { github: true, youtube: true, gmail: true, calendar: true, web: true },
  mcpServers: {},
  extraAllowedTools: [],
  youtubeChannels: [],
  dailySyncTime: "08:30",
  theme: "system",
  openAtLogin: true,
  mascotVisible: true,
  mascotSize: "medium",
  sleepAfterMinutes: 10,
  notifier: { autoShow: true, hideAfterSeconds: 12 },
  shortcut: "Control+Shift+Space",
  ...over,
});

export const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "A task",
  notes: "",
  source: "me",
  link: "",
  due: null,
  done: false,
  createdAt: "2026-11-16T08:00:00.000Z",
  doneAt: null,
  ...over,
});

export const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: "r1",
  text: "Stretch",
  dueAt: "2999-01-01T09:00:00.000Z",
  repeat: "none",
  createdAt: "2026-11-16T08:00:00.000Z",
  ...over,
});

export const notification = (over: Partial<SidekickNotification> = {}): SidekickNotification => ({
  id: "n1",
  kind: "info",
  title: "Hello",
  body: "",
  link: "",
  at: new Date().toISOString(),
  ...over,
});

export const hello = (over: Partial<Hello> = {}): Hello => ({
  status: { state: "ready", model: "claude-opus-5-5", connectors: [] },
  history: [],
  config: config(),
  tasks: [],
  reminders: [],
  notifications: [],
  skin: false,
  ...over,
});

export const options: Options = {
  models: [
    { id: null, label: "Default", note: "Claude Code's default model" },
    { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
  ],
  efforts: [
    { id: "low", label: "Low", hint: "Fast" },
    { id: "medium", label: "Medium", hint: "Balanced" },
    { id: "high", label: "High", hint: "Thorough" },
  ],
  responseStyles: [
    { id: "brief", label: "Brief", hint: "Short" },
    { id: "balanced", label: "Balanced", hint: "Default" },
    { id: "detailed", label: "Detailed", hint: "Long" },
  ],
  themes: ["system", "light", "dark"],
  mascotSizes: ["small", "medium", "large"],
};

export const PRIVATE_EMAIL = "someone@example.com";

export const info = (over: Partial<Info> = {}): Info => ({
  app: { name: "Sidekick", version: "1.0.1", tauri: "2.12.5", webview: "157.0.0.0", platform: "Windows 10.0.26200", arch: "x86_64" },
  dataDir: "C:\\Users\\me\\AppData\\Roaming\\sidekick",
  claude: {
    found: true,
    path: "C:\\Users\\me\\.local\\bin\\claude.exe",
    version: "2.9.0 (Claude Code)",
    auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: PRIVATE_EMAIL, orgName: null },
  },
  github: { installed: true, loggedIn: true, user: "octocat" },
  connectors: [{ name: "claude.ai Gmail", status: "connected", source: "claudeai" }],
  ...over,
});
