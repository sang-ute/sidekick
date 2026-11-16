// Typed calls into the Rust core (Tauri commands). Every call rejects with an Error
// carrying the core's message, like the old HTTP API did.
import { invoke } from "@tauri-apps/api/core";
import type { Config, Hello, Info, Reminder, SettingsResponse, Task } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

export const api = {
  // chat
  hello: () => call<Hello>("hello"),
  chat: (text: string) => call<void>("chat", { text }),
  reset: () => call<void>("reset"),
  sync: () => call<void>("sync"),
  // tasks & reminders
  tasks: () => call<Task[]>("tasks_list"),
  addTask: (title: string) => call<{ task: Task; duplicate: boolean }>("task_add", { title }),
  updateTask: (id: string, patch: { done?: boolean; title?: string }) => call<Task>("task_update", { id, ...patch }),
  deleteTask: (id: string) => call<boolean>("task_delete", { id }),
  reminders: () => call<Reminder[]>("reminders_list"),
  deleteReminder: (id: string) => call<boolean>("reminder_delete", { id }),
  // notifications
  clearNotifications: () => call<void>("notifications_clear"),
  deleteNotification: (id: string) => call<boolean>("notification_delete", { id }),
  // settings & info
  settings: () => call<SettingsResponse>("settings_get"),
  patchSettings: (patch: Partial<Config> | Record<string, unknown>) => call<Config>("settings_patch", { patch }),
  info: () => call<Info>("info"),
  skin: () => call<string | null>("skin"),
  // account & connections
  claudeLogin: (method: "claudeai" | "console") => call<void>("claude_login", { method }),
  claudeLogout: () => call<unknown>("claude_logout"),
  claudeRestart: () => call<void>("claude_restart"),
  githubLogin: () => call<void>("github_login"),
  mcpLogin: (name: string) => call<void>("mcp_login", { name }),
  open: (target: "connectors" | "dataFolder") => call<void>("open_target", { target }),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

// Window controls (the desktop shell).
export const shell = {
  togglePanel: () => call<void>("toggle_panel"),
  openPanel: () => call<void>("open_panel"),
  closePanel: () => call<void>("close_panel"),
  openSettings: () => call<void>("open_settings"),
  closeSettings: () => call<void>("close_settings"),
  dragStart: () => call<void>("pet_drag_start"),
  dragMove: (dx: number, dy: number) => call<void>("pet_drag_move", { dx, dy }),
  dragEnd: () => call<void>("pet_drag_end"),
  hitRects: (rects: { x: number; y: number; w: number; h: number }[]) => call<void>("pet_hit_rects", { rects }),
  showMenu: () => call<void>("pet_menu"),
};
