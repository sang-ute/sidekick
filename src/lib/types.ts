// Types for the data the Rust core sends to the React UI (they mirror src-tauri/src/*.rs).

export type TaskSource = "me" | "gmail" | "github" | "youtube" | "calendar" | "other";
export const TASK_SOURCES: TaskSource[] = ["me", "gmail", "github", "youtube", "calendar", "other"];

export interface Task {
  id: string;
  title: string;
  notes: string;
  source: TaskSource;
  link: string;
  due: string | null; // ISO
  done: boolean;
  createdAt: string;
  doneAt: string | null;
}

export type Repeat = "none" | "daily" | "weekly";
export interface Reminder {
  id: string;
  text: string;
  dueAt: string; // ISO
  repeat: Repeat;
  createdAt: string;
}

export type NotificationKind = "reminder" | "sync" | "task" | "error" | "info";
export interface SidekickNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string; // "" when there is none
  at: string; // ISO
}

export type ConnectorStatus = "connected" | "needs-auth" | "failed" | "pending";
export interface Connector {
  name: string;
  status: ConnectorStatus | (string & {}); // known values autocomplete; Claude Code may add others
  source?: "sidekick" | "claudeai" | "user";
}

export type SessionState = "missing" | "idle" | "starting" | "ready" | "stopped";
export interface Status {
  state: SessionState;
  model: string | null;
  connectors: Connector[];
}

export interface Integrations {
  github: boolean;
  youtube: boolean;
  gmail: boolean;
  calendar: boolean;
  web: boolean;
}

export interface McpServerStdio {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpServerHttp {
  type: "http";
  url: string;
  headers: Record<string, string>;
}
export type McpServerConfig = McpServerStdio | McpServerHttp;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ResponseStyle = "brief" | "balanced" | "detailed";
export type Theme = "system" | "light" | "dark";
export type MascotSize = "small" | "medium" | "large";

export interface Config {
  model: string | null;
  effort: Effort;
  responseStyle: ResponseStyle;
  language: string;
  integrations: Integrations;
  mcpServers: Record<string, McpServerConfig>;
  extraAllowedTools: string[];
  youtubeChannels: string[];
  dailySyncTime: string | null;
  theme: Theme;
  openAtLogin: boolean;
  mascotVisible: boolean;
  mascotSize: MascotSize;
  sleepAfterMinutes: number;
  notifier: { autoShow: boolean; hideAfterSeconds: number };
  shortcut: string;
}

export interface Options {
  models: { id: string | null; label: string; note: string }[];
  efforts: { id: Effort; label: string; hint: string }[];
  responseStyles: { id: ResponseStyle; label: string; hint: string }[];
  themes: Theme[];
  mascotSizes: MascotSize[];
}

export interface SettingsResponse {
  config: Config;
  defaults: Config;
  options: Options;
}

export interface Info {
  app: {
    name: string;
    version: string;
    tauri: string;
    webview: string | null; // WebView2 runtime version
    platform: string;
    arch: string;
  };
  dataDir: string;
  claude: {
    found: boolean;
    path: string | null;
    version: string | null;
    auth: {
      loggedIn: boolean;
      authMethod: string | null;
      apiProvider: string | null;
      subscriptionType: string | null;
      email: string | null;
      orgName: string | null;
    } | null;
  };
  github: { installed: boolean; loggedIn: boolean; user: string | null };
  connectors: Connector[];
}

/** One entry of the chat replay buffer. */
export interface HistoryItem {
  type: ChatEventType;
  data: unknown;
}
export type ChatEventType = "user" | "delta" | "tool" | "note" | "done" | "failure" | "reminder";

/** First message on the event stream. */
export interface Hello {
  status: Status;
  history: HistoryItem[];
  config: Config;
  tasks: Task[];
  reminders: Reminder[];
  notifications: SidekickNotification[]; // newest first
  skin: boolean;
}

/** Everything the server pushes over /api/events (data is JSON). */
export interface EventMap {
  hello: Hello;
  user: string;
  delta: string;
  tool: string;
  note: string;
  done: null;
  failure: string;
  reminder: Reminder;
  tasks: Task[];
  reminders: Reminder[];
  notify: SidekickNotification;
  notifications: SidekickNotification[];
  config: Config;
  status: Status;
  reset: null;
}
export type EventName = keyof EventMap;
