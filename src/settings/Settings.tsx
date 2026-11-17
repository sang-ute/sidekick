// Sidekick settings window: General, AI & account, Connections, Mascot & alerts, About.
// Every change saves right away (text fields after a short pause) and rolls back with
// the core's message if it's rejected.
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, shell } from "../lib/api";
import { applyTheme } from "../lib/dom";
import { subscribe } from "../lib/events";
import type { Config, Connector, Info, McpServerConfig, Options } from "../lib/types";

type Tab = "general" | "ai" | "connections" | "mascot" | "about";
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "general", icon: "⚙️", label: "General" },
  { id: "ai", icon: "✨", label: "AI & account" },
  { id: "connections", icon: "🔌", label: "Connections" },
  { id: "mascot", icon: "🫧", label: "Mascot & alerts" },
  { id: "about", icon: "ℹ️", label: "About" },
];
const session = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} },
};

// ---------- small building blocks ----------
type Toast = { msg: string; kind: "ok" | "err" | "info" } | null;

function Seg<T extends string>({ items, current, onPick, label }: { items: { id: T; label: string; hint?: string }[]; current: T; onPick: (v: T) => void; label: string }) {
  const onKey = (e: KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!step) return;
    e.preventDefault();
    const idx = Math.max(0, items.findIndex((it) => it.id === current));
    onPick(items[(idx + step + items.length) % items.length].id);
  };
  const known = items.some((it) => it.id === current);
  return (
    // Roving focus: the checked radio is focusable and the arrow keys move between them (ARIA radio group).
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus
    <div className="seg" role="radiogroup" aria-labelledby={label} onKeyDown={onKey}>
      {items.map((it, i) => {
        const on = it.id === current;
        return (
          <button key={it.id} type="button" role="radio" aria-checked={on} tabIndex={on || (!known && i === 0) ? 0 : -1} title={it.hint} onClick={() => { if (!on) onPick(it.id); }}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function Switch({ checked, onChange, id, label, title }: { checked: boolean; onChange: (v: boolean) => void; id?: string; label?: string; title?: string }) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" id={id} aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

function Pill({ kind = "", children }: { kind?: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
function StatusPill({ status }: { status: string }) {
  switch (status) {
    case "connected": return <Pill kind="ok">Connected</Pill>;
    case "needs-auth": return <Pill kind="warn">Needs sign-in</Pill>;
    case "failed": return <Pill kind="err">Failed</Pill>;
    case "pending": return <Pill>Starting…</Pill>;
    default: return <Pill>{status || "Unknown"}</Pill>;
  }
}
const SKELETON_WIDTHS = ["w60", "w80", "w40"];
function Skeleton({ widths = SKELETON_WIDTHS }: { widths?: string[] }) {
  return <>{widths.map((w, i) => <span key={i} className={`skel ${w}`} />)}</>;
}

/** A text value that follows the config but isn't overwritten while you're typing in it. */
function useDraft(value: string): [string, (v: string) => void, { onFocus: () => void; onBlur: () => void }] {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return [draft, setDraft, { onFocus: () => { focused.current = true; }, onBlur: () => { focused.current = false; } }];
}

// ---------- helpers ----------
const THEME_LABEL: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };
const SIZE_LABEL: Record<string, string> = { small: "Small", medium: "Medium", large: "Large" };
const MOD_KEYS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const KEY_RE = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|plus|printscreen|num[0-9]|[)!@#$%^&*(:;<_>?~{|}"',./`[\]\\=-])$/i;
function validShortcut(s: string) {
  const parts = s.split("+").map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return false;
  const key = parts.pop()!;
  return parts.every((p) => MOD_KEYS.has(p.toLowerCase())) && KEY_RE.test(key);
}
type Auth = NonNullable<Info["claude"]["auth"]>;
function methodLabel(auth: Auth) {
  const provider = (auth.apiProvider || "").toLowerCase();
  if (provider && provider !== "firstparty") {
    return ({ bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry" } as Record<string, string>)[provider] || auth.apiProvider || "";
  }
  const m = (auth.authMethod || "").toLowerCase();
  if (m.includes("claude")) return "Claude subscription (claude.ai)";
  if (m.includes("console") || m.includes("api")) return "Anthropic Console (API billing)";
  return auth.authMethod || "Unknown";
}
const titleCase = (s: string) => (s || "").replace(/(^|[\s_-])(\w)/g, (_, a: string, b: string) => a + b.toUpperCase());
const ghText = (gh: Info["github"] | undefined) => (!gh ? "Checking…" : !gh.installed ? "Not installed" : gh.loggedIn ? `Signed in${gh.user ? ` as @${gh.user}` : ""}` : "Signed out");

/** "a b 'c d'" → ["a", "b", "c d"]; backslashes are kept as-is (Windows paths). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { out.push(cur); cur = ""; started = false; } continue; }
    cur += ch;
    started = true;
  }
  if (quote) throw new Error("An argument has an unclosed quote.");
  if (started) out.push(cur);
  return out;
}
function parseKV(text: string, kind: "env" | "headers"): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let idx = line.indexOf("=");
    if (kind === "headers" && (idx < 0 || (line.indexOf(":") >= 0 && line.indexOf(":") < idx))) idx = line.indexOf(":");
    if (idx <= 0) throw new Error(`Line ${i + 1} should look like ${kind === "headers" ? "Name: value" : "KEY=VALUE"}.`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`"${key}" isn't a valid variable name.`);
    if (kind === "headers" && !/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`"${key}" isn't a valid header name.`);
    out[key] = value;
  });
  return out;
}
const serverSummary = (s: McpServerConfig) =>
  s.type === "http" ? s.url || "" : [s.command, ...(s.args || [])].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

const BUILTINS = [
  { key: "github", icon: "🐙", name: "GitHub", desc: "PRs waiting for your review, assigned issues and notifications. Read-only, via the gh CLI." },
  { key: "gmail", icon: "✉️", name: "Gmail", desc: "Finds mail that needs a reply. Uses your claude.ai Gmail connector." },
  { key: "calendar", icon: "📅", name: "Google Calendar", desc: "Upcoming events. Uses your claude.ai Calendar connector." },
  { key: "youtube", icon: "▶️", name: "YouTube", desc: "New videos from channels you follow. No account needed." },
  { key: "web", icon: "🔎", name: "Web search & fetch", desc: "Lets Claude look things up online." },
] as const;

// ======================================================================
export function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [defaults, setDefaults] = useState<Partial<Config>>({});
  const [options, setOptions] = useState<Options | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [liveConnectors, setLiveConnectors] = useState<Connector[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === session.get("sidekick-settings-tab")) ? (session.get("sidekick-settings-tab") as Tab) : "general"));
  const [toast, setToast] = useState<Toast>(null);
  const configRef = useRef<Config | null>(null);
  configRef.current = config;
  const contentRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // ---------- toast ----------
  const toastTimer = useRef(0);
  const showToast = useCallback((msg: string, kind: "ok" | "err" | "info" = "ok") => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "err" ? 5000 : kind === "info" ? 4000 : 1600);
  }, []);

  // ---------- saving (sequential, optimistic) ----------
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback((partial: Partial<Config>): Promise<boolean> => {
    const prev = configRef.current;
    if (prev) setConfig({ ...prev, ...partial });
    const run = queue.current.then(async () => {
      try {
        setConfig(await api.patchSettings(partial));
        showToast("Saved ✓");
        return true;
      } catch (e) {
        if (prev) setConfig(prev);
        showToast((e as Error).message, "err");
        return false;
      }
    });
    queue.current = run.catch(() => false);
    return run;
  }, [showToast]);

  // Debounced saves for text inputs; flushPending() runs them now (on close/hide).
  const pending = useRef(new Map<string, { timer: number; fn: () => void }>());
  const saveLater = useCallback((key: string, makePartial: () => Partial<Config> | null, ms = 500) => {
    const old = pending.current.get(key);
    if (old) clearTimeout(old.timer);
    const entry = { timer: 0, fn: () => { pending.current.delete(key); const p = makePartial(); if (p) void save(p); } };
    entry.timer = window.setTimeout(entry.fn, ms);
    pending.current.set(key, entry);
  }, [save]);
  const cancelLater = (key: string) => {
    const e = pending.current.get(key);
    if (e) { clearTimeout(e.timer); pending.current.delete(key); }
  };
  const flushPending = useCallback(() => {
    for (const e of Array.from(pending.current.values())) { clearTimeout(e.timer); e.fn(); }
  }, []);

  const post = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | null> => {
    try {
      const res = await fn();
      if (okMsg) showToast(okMsg, "info");
      return res ?? (true as T);
    } catch (e) {
      showToast((e as Error).message, "err");
      return null;
    }
  }, [showToast]);
  const openTarget = (t: "connectors" | "dataFolder") => post(() => api.open(t));

  // ---------- loading ----------
  const infoInFlight = useRef<Promise<void> | null>(null);
  const loadInfo = useCallback((announce = false, quiet = false) => {
    if (infoInFlight.current) return infoInFlight.current;
    if (!quiet) { setInfo(null); setInfoError(null); }
    infoInFlight.current = (async () => {
      try {
        setInfo(await api.info());
        setInfoError(null);
        if (announce) showToast("Refreshed ✓");
      } catch (e) {
        if (!quiet) { setInfo(null); setInfoError((e as Error).message); }
      } finally {
        infoInFlight.current = null;
      }
    })();
    return infoInFlight.current;
  }, [showToast]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.settings();
        setConfig(s.config);
        setDefaults(s.defaults || {});
        setOptions(s.options);
        setLoadError(null);
      } catch (e) {
        setLoadError(`Couldn't load settings: ${(e as Error).message}`);
      }
    })();
    void loadInfo();
    return subscribe({
      hello: (h) => { setConfig(h.config); if (h.status?.connectors) setLiveConnectors(h.status.connectors); },
      config: (c) => setConfig(c),
      status: (s) => { if (Array.isArray(s.connectors) && s.connectors.length) setLiveConnectors(s.connectors); },
    });
  }, [loadInfo]);

  useEffect(() => { if (config) applyTheme(config); }, [config]);
  // Open with nothing focused (WebView2 otherwise focuses the first field).
  useEffect(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }, [options]);
  useEffect(() => { document.body.classList.toggle("loading", !config || !options); }, [config, options]);

  // ---------- window ----------
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { flushPending(); void shell.closeSettings(); }
    };
    const onVis = () => { if (document.hidden) flushPending(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", flushPending);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", flushPending);
    };
  }, [flushPending]);

  // ---------- tabs ----------
  const showTab = (name: Tab, focus = false) => {
    setTab(name);
    session.set("sidekick-settings-tab", name);
    if (contentRef.current) contentRef.current.scrollTop = 0;
    const el = tabRefs.current[name];
    if (el) {
      if (focus) el.focus();
      el.scrollIntoView({ block: "nearest", inline: "nearest" }); // narrow layout: tabs scroll sideways
    }
  };
  const onTabKey = (e: KeyboardEvent, current: Tab) => {
    const i = TABS.findIndex((t) => t.id === current);
    const next = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (next) { e.preventDefault(); showTab(TABS[(i + next + TABS.length) % TABS.length].id, true); }
    if (e.key === "Home") { e.preventDefault(); showTab(TABS[0].id, true); }
    if (e.key === "End") { e.preventDefault(); showTab(TABS[TABS.length - 1].id, true); }
  };

  // ---------- connectors (info + live status) ----------
  const connectors = (): Connector[] => {
    const byName = new Map<string, Connector>();
    for (const c of info?.connectors || []) byName.set(c.name, { ...c });
    for (const c of liveConnectors || []) byName.set(c.name, { ...byName.get(c.name), ...c });
    return [...byName.values()].filter((c) => c.name !== "sidekick");
  };
  const findConnector = (re: RegExp) => connectors().find((c) => re.test(c.name));
  const mcpLogin = (name: string) => post(() => api.mcpLogin(name), `Finish authorizing ${name.replace(/^claude\.ai /, "")} in the window that just opened.`);

  // ---------- sign-in polling ----------
  const pollTimer = useRef(0);
  const infoRef = useRef<Info | null>(null);
  infoRef.current = info;
  const login = async (method: "claudeai" | "console") => {
    const ok = await post(() => api.claudeLogin(method), "Finish signing in in the terminal and browser window that just opened.");
    if (!ok) return;
    const before = JSON.stringify(infoRef.current?.claude?.auth || null);
    let tries = 0;
    clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      tries += 1;
      await loadInfo(false, true);
      const now = JSON.stringify(infoRef.current?.claude?.auth || null);
      if (now !== before || tries >= 24) {
        clearInterval(pollTimer.current);
        if (now !== before && infoRef.current?.claude?.auth?.loggedIn) showToast("Signed in ✓");
      }
    }, 5000);
  };
  const logout = async () => {
    if (!confirm("Sign out of Claude Code?\n\nSidekick, and Claude Code in your terminals, won't work until you sign in again.")) return;
    const res = await post(() => api.claudeLogout());
    if (!res) return;
    showToast("Signed out", "info");
    void loadInfo();
  };

  // ---------- drafts for text fields ----------
  const [shortcut, setShortcut, shortcutFocus] = useDraft(config?.shortcut || "");
  const [shortcutBad, setShortcutBad] = useState(false);
  const [language, setLanguage, languageFocus] = useDraft(config?.language || "");
  const [syncTime, setSyncTime, syncTimeFocus] = useDraft(config?.dailySyncTime || defaults.dailySyncTime || "08:30");
  const [sleepAfter, setSleepAfter, sleepFocus] = useDraft(String(config?.sleepAfterMinutes ?? 10));
  const [hideAfter, setHideAfter, hideFocus] = useDraft(String(config?.notifier?.hideAfterSeconds ?? 12));
  const clampNum = (v: string, min: number, max: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && v !== "" ? Math.min(max, Math.max(min, n)) : null;
  };

  // ---------- custom MCP form ----------
  const [addOpen, setAddOpen] = useState(false);
  const [mcpType, setMcpType] = useState<"stdio" | "http">("stdio");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpKV, setMcpKV] = useState("");
  const [mcpAuto, setMcpAuto] = useState(false);
  const [mcpErr, setMcpErr] = useState("");
  const addServer = async (e: FormEvent) => {
    e.preventDefault();
    setMcpErr("");
    const c = configRef.current;
    if (!c) return;
    const name = mcpName.trim();
    const servers = c.mcpServers || {};
    try {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error("Name: letters, numbers, - and _ only (up to 40).");
      if (name.toLowerCase() === "sidekick") throw new Error('"sidekick" is taken by Sidekick\'s own tools.');
      if (Object.keys(servers).some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`A server named "${name}" already exists.`);
      let server: McpServerConfig;
      if (mcpType === "http") {
        const url = mcpUrl.trim();
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error("Enter a full URL, like https://example.com/mcp."); }
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("The URL must start with http:// or https://.");
        server = { type: "http", url, headers: parseKV(mcpKV, "headers") };
      } else {
        const command = mcpCommand.trim();
        if (!command) throw new Error("Enter the command that starts the server, like npx.");
        server = { type: "stdio", command, args: splitArgs(mcpArgs.trim()), env: parseKV(mcpKV, "env") };
      }
      const patch: Partial<Config> = { mcpServers: { ...servers, [name]: server } };
      if (mcpAuto) patch.extraAllowedTools = [...new Set([...(c.extraAllowedTools || []), `mcp__${name}`])];
      if (await save(patch)) {
        setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpUrl(""); setMcpKV(""); setMcpAuto(false); setMcpType("stdio");
        setAddOpen(false);
        showToast(`Added ${name}. Claude Code is restarting to load it.`, "info");
      }
    } catch (err) {
      setMcpErr((err as Error).message);
    }
  };

  // ---------- chip editors ----------
  const [ytInput, setYtInput] = useState("");
  const [toolInput, setToolInput] = useState("");
  const addChannel = (e: FormEvent) => {
    e.preventDefault();
    let v = ytInput.trim();
    if (!v || !config) return;
    if (/\s/.test(v)) return showToast("Channel names can't contain spaces. Use the @handle.", "err");
    if (!/^https?:\/\//i.test(v) && !/^UC[\w-]{22}$/.test(v) && !v.startsWith("@")) v = `@${v}`;
    const list = config.youtubeChannels || [];
    if (list.some((c) => c.toLowerCase() === v.toLowerCase())) return showToast("Already following that channel.", "err");
    setYtInput("");
    void save({ youtubeChannels: [...list, v] });
  };
  const addTool = (e: FormEvent) => {
    e.preventDefault();
    const v = toolInput.trim();
    if (!v || !config) return;
    if (v.includes(",") || v.length > 120) return showToast("One tool name per entry, no commas.", "err");
    const list = config.extraAllowedTools || [];
    if (list.includes(v)) return showToast("Already on the list.", "err");
    setToolInput("");
    void save({ extraAllowedTools: [...list, v] });
  };
  const Chips = ({ items, onRemove, empty, label }: { items: string[]; onRemove: (s: string) => void; empty: string; label: string }) => (
    <div className="chips" aria-label={label} data-empty={empty}>
      {items.map((item) => (
        <span key={item} className="chip">
          <span>{item}</span>
          <button type="button" aria-label={`Remove ${item}`} onClick={() => onRemove(item)}>✕</button>
        </span>
      ))}
    </div>
  );

  // ---------- diagnostics ----------
  const diagnostics = () => {
    const app = info?.app;
    const auth = info?.claude?.auth;
    const c = config;
    return [
      `Sidekick ${app?.version || "?"}`,
      `Tauri ${app?.tauri || "-"} / WebView2 ${app?.webview || "-"}`,
      `Platform: ${[app?.platform, app?.arch].filter(Boolean).join(" ") || "-"}`,
      `Claude Code: ${info?.claude?.found ? `found ${info.claude.version || ""}`.trim() : "not found"}`,
      `Claude auth: ${auth ? (auth.loggedIn ? `signed in (${methodLabel(auth)}${auth.subscriptionType ? `, ${auth.subscriptionType}` : ""})` : "signed out") : "unknown"}`,
      `GitHub CLI: ${info?.github ? (!info.github.installed ? "not installed" : info.github.loggedIn ? "signed in" : "signed out") : "unknown"}`,
      `Connectors: ${connectors().map((x) => `${x.name.replace(/^claude\.ai /, "")}=${x.status}`).join(", ") || "none"}`,
      `Model: ${c?.model || "default"} / effort ${c?.effort || "-"} / style ${c?.responseStyle || "-"}`,
      `Integrations: ${Object.entries(c?.integrations || {}).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ") || "-"}`,
      `Custom MCP servers: ${Object.keys(c?.mcpServers || {}).length}`,
      `YouTube channels: ${(c?.youtubeChannels || []).length}`,
      `Daily sync: ${c?.dailySyncTime || "off"} / theme ${c?.theme || "system"} / mascot ${c?.mascotVisible === false ? "hidden" : c?.mascotSize || "medium"}`,
    ].join("\n");
  };
  const copyDiagnostics = async () => {
    try { await navigator.clipboard.writeText(diagnostics()); showToast("Diagnostics copied ✓"); }
    catch { showToast("Couldn't copy to the clipboard", "err"); }
  };

  // ======================================================================
  const ready = config && options;
  const c = config;
  const o = options;
  const claude = info?.claude;
  const auth = claude?.auth;
  const signedIn = Boolean(auth?.loggedIn);
  const models = o?.models || [];
  const curModel = c?.model ?? "";
  const efforts = o?.efforts || [];
  const styles = o?.responseStyles || [];
  const integ = c?.integrations;

  return (
    <>
      <header className="titlebar" data-tauri-drag-region="deep">
        <div className="brand">
          <svg className="sparkle" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 1 Q13.7 10.3 23 12 Q13.7 13.7 12 23 Q10.3 13.7 1 12 Q10.3 10.3 12 1Z" />
          </svg>
          <span>Sidekick settings</span>
        </div>
        <span className="conn" role="status" aria-live="polite" />
        <button className="win-close" type="button" aria-label="Close settings" title="Close (Esc)" onClick={() => { flushPending(); void shell.closeSettings(); }}>✕</button>
      </header>

      <div className="layout">
        <div className="sidebar" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={`panel-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => showTab(t.id)}
              onKeyDown={(e) => onTabKey(e, t.id)}
            >
              <span aria-hidden="true">{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        <main className="content" ref={contentRef}>
          <div className="banner err" role="alert" hidden={!loadError}>{loadError}</div>

          {/* ===================== General ===================== */}
          <section id="panel-general" className="panel" role="tabpanel" aria-labelledby="tab-general" tabIndex={0} hidden={tab !== "general"}>
            <h1>General</h1>
            <p className="lede">How Sidekick looks and starts.</p>
            {ready && (
              <>
                <div className="card">
                  <div className="row">
                    <div className="label"><span id="lbl-theme">Theme</span><small>Follow Windows, or pick one.</small></div>
                    <Seg label="lbl-theme" items={o!.themes.map((id) => ({ id, label: THEME_LABEL[id] || id }))} current={c!.theme} onPick={(v) => save({ theme: v })} />
                  </div>
                  <div className="row">
                    <label className="label" htmlFor="openAtLogin">Start with Windows<small>Open Sidekick when you sign in to your PC.</small></label>
                    <Switch id="openAtLogin" checked={c!.openAtLogin} onChange={(v) => save({ openAtLogin: v })} />
                  </div>
                  <div className="row">
                    <label className="label" htmlFor="shortcut">Keyboard shortcut<small>Opens and closes the chat from anywhere.</small></label>
                    <div className="field">
                      <input
                        id="shortcut"
                        className={`input mono${shortcutBad ? " invalid" : ""}`}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="Control+Shift+Space"
                        aria-describedby="shortcutErr"
                        value={shortcut}
                        {...shortcutFocus}
                        onBlur={() => { shortcutFocus.onBlur(); if (!pending.current.has("shortcut")) { setShortcut(c!.shortcut); setShortcutBad(false); } }}
                        onChange={(e) => {
                          const v = e.target.value;
                          setShortcut(v);
                          const ok = validShortcut(v.trim());
                          setShortcutBad(!ok);
                          if (ok) saveLater("shortcut", () => ({ shortcut: v.trim() }), 700);
                          else cancelLater("shortcut");
                        }}
                      />
                      <small id="shortcutErr" className="field-err" hidden={!shortcutBad}>Use modifiers and a key, like Control+Shift+Space.</small>
                    </div>
                  </div>
                </div>

                <h2>Daily sync</h2>
                <div className="card">
                  <div className="row">
                    <label className="label" htmlFor="syncOn">Sync every day<small>Checks GitHub, Gmail and YouTube and pins new to-dos. If the PC was off at that time, it runs right after you sign in.</small></label>
                    <Switch id="syncOn" checked={Boolean(c!.dailySyncTime)} onChange={(on) => save({ dailySyncTime: on ? syncTime || defaults.dailySyncTime || "08:30" : null })} />
                  </div>
                  <div className="row" hidden={!c!.dailySyncTime}>
                    <label className="label" htmlFor="syncTime">Time<small>Your local time.</small></label>
                    <input
                      type="time"
                      id="syncTime"
                      className="input narrow"
                      value={syncTime}
                      {...syncTimeFocus}
                      onChange={(e) => {
                        setSyncTime(e.target.value);
                        if (c!.dailySyncTime && /^\d{2}:\d{2}$/.test(e.target.value)) void save({ dailySyncTime: e.target.value });
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ===================== AI & account ===================== */}
          <section id="panel-ai" className="panel" role="tabpanel" aria-labelledby="tab-ai" tabIndex={0} hidden={tab !== "ai"}>
            <h1>AI &amp; account</h1>
            <p className="lede">Sidekick runs on your Claude Code. Pick the account, the model and how it answers.</p>

            <div className="card account" aria-busy={!info || undefined}>
              <div className="account-head">
                <span className={`big-dot${!info ? "" : !claude?.found ? " err" : signedIn ? " ok" : " warn"}`} aria-hidden="true" />
                <div className="account-id">
                  <div className="acct-title">
                    {!info ? (infoError ? "Couldn't check Claude Code" : "Checking Claude Code…") : !claude?.found ? "Claude Code not found" : signedIn ? "Signed in" : "Not signed in"}
                  </div>
                  <div className="muted small">
                    {!info ? infoError || "" : !claude?.found ? "Install Claude Code, then run claude once in a terminal." : signedIn ? methodLabel(auth!) : "Sign in so Sidekick can use Claude."}
                  </div>
                </div>
                <button type="button" className="btn ghost small" onClick={() => loadInfo(true)}>↻ Refresh</button>
              </div>
              <dl className="details">
                {!info && !infoError && <Skeleton />}
                {info && signedIn && (
                  <>
                    {auth!.subscriptionType && <><dt>Plan</dt><dd>{titleCase(auth!.subscriptionType)}</dd></>}
                    {auth!.email && <><dt>Email</dt><dd>{auth!.email}</dd></>}
                    {auth!.orgName && <><dt>Organization</dt><dd>{auth!.orgName}</dd></>}
                    {claude?.version && <><dt>Claude Code</dt><dd>{`v${claude.version.replace(/^v/, "")}`}</dd></>}
                  </>
                )}
              </dl>
              <div className="btn-row">
                <button type="button" className={signedIn ? "btn" : "btn primary"} disabled={!info || !claude?.found} onClick={() => login("claudeai")}>
                  {signedIn ? "Switch Claude account" : "Sign in with Claude subscription"}
                </button>
                <button type="button" className="btn" disabled={!info || !claude?.found} onClick={() => login("console")}>
                  {signedIn ? "Use Anthropic Console (API billing)" : "Sign in with Anthropic Console (API billing)"}
                </button>
                <button type="button" className="btn danger" disabled={!signedIn} onClick={logout}>Sign out</button>
              </div>
              <p className="hint">Signing in opens a terminal and a browser window. Finish there, then press Refresh.</p>
            </div>
            <p className="fine">Sidekick runs on Claude Code, so other AI providers (OpenAI, Gemini…) aren't supported. Amazon Bedrock, Google Vertex AI and Microsoft Foundry work through Claude Code's own environment settings.</p>

            {ready && (
              <>
                <h2>Model &amp; answers</h2>
                <div className="card">
                  <div className="row stack">
                    <label className="label" htmlFor="model">Model</label>
                    <select id="model" className="input" value={curModel} onChange={(e) => save({ model: e.target.value || null })}>
                      {models.map((m) => <option key={m.id ?? ""} value={m.id ?? ""}>{m.label}</option>)}
                      {!models.some((m) => (m.id ?? "") === curModel) && <option value={curModel}>{`${curModel} (custom)`}</option>}
                    </select>
                    <small className="hint">{models.find((m) => (m.id ?? "") === curModel)?.note || ""}</small>
                  </div>
                  <div className="row stack">
                    <div className="label"><span id="lbl-effort">Effort</span><small>How hard Claude thinks before answering. Higher is slower and uses more of your plan.</small></div>
                    <Seg label="lbl-effort" items={efforts} current={c!.effort} onPick={(v) => save({ effort: v })} />
                    <small className="hint">{efforts.find((e) => e.id === c!.effort)?.hint || ""}</small>
                  </div>
                  <div className="row stack">
                    <div className="label"><span id="lbl-style">Response style</span></div>
                    <Seg label="lbl-style" items={styles} current={c!.responseStyle} onPick={(v) => save({ responseStyle: v })} />
                    <small className="hint">{styles.find((s) => s.id === c!.responseStyle)?.hint || ""}</small>
                  </div>
                  <div className="row">
                    <label className="label" htmlFor="language">Reply language<small>Leave empty to match the language you write in.</small></label>
                    <input
                      id="language"
                      className="input"
                      autoComplete="off"
                      placeholder="Match my language"
                      maxLength={40}
                      value={language}
                      {...languageFocus}
                      onChange={(e) => { const v = e.target.value; setLanguage(v); saveLater("language", () => ({ language: v.trim() })); }}
                    />
                  </div>
                </div>
                <div className="restart-note">
                  <span>↻ Claude Code restarts when you change these.</span>
                  <button type="button" className="btn small" onClick={() => post(() => api.claudeRestart(), "Claude Code is restarting…")}>Restart Claude Code</button>
                </div>
              </>
            )}
          </section>

          {/* ===================== Connections ===================== */}
          <section id="panel-connections" className="panel" role="tabpanel" aria-labelledby="tab-connections" tabIndex={0} hidden={tab !== "connections"}>
            <h1>Connections</h1>
            <p className="lede">What Sidekick can reach. It never sends, deletes or changes anything unless you ask in the chat.</p>

            {ready && integ && (
              <>
                <h2>Built-in tools</h2>
                <div className="card list">
                  {BUILTINS.map((b) => {
                    const enabled = integ[b.key];
                    let side: ReactNode = null;
                    if (b.key === "github") {
                      const gh = info?.github;
                      side = !gh ? <Pill>Checking…</Pill>
                        : !gh.installed ? <><Pill kind="warn">gh not installed</Pill><a className="link" href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">Get GitHub CLI ↗</a></>
                        : !gh.loggedIn ? <><Pill kind="warn">Signed out</Pill><button type="button" className="btn small" onClick={async () => {
                            if (await post(() => api.githubLogin(), "Finish signing in in the terminal that just opened, then press Refresh on the AI tab.")) setTimeout(() => loadInfo(false, true), 15000);
                          }}>Sign in to GitHub</button></>
                        : <Pill kind="ok">{gh.user ? `@${gh.user}` : "Signed in"}</Pill>;
                    } else if (b.key === "gmail" || b.key === "calendar") {
                      const conn = findConnector(b.key === "gmail" ? /gmail/i : /calendar/i);
                      side = !conn && !info && !liveConnectors ? <Pill>Checking…</Pill>
                        : !conn ? <><Pill>Not connected</Pill><button type="button" className="btn small" onClick={() => openTarget("connectors")}>Connect on claude.ai</button></>
                        : <><StatusPill status={conn.status} />{conn.status === "needs-auth" && <button type="button" className="btn small" onClick={() => mcpLogin(conn.name)}>Authorize</button>}</>;
                    } else if (b.key === "youtube") {
                      const n = (c.youtubeChannels || []).length;
                      side = <Pill kind={n ? "info" : ""}>{n ? `${n} channel${n === 1 ? "" : "s"}` : "No channels yet"}</Pill>;
                    } else {
                      side = <Pill kind="info">Built in</Pill>;
                    }
                    return (
                      <div key={b.key} className={`item${enabled ? "" : " off"}`}>
                        <div className="ic" aria-hidden="true">{b.icon}</div>
                        <div className="main"><div className="name">{b.name}</div><div className="desc">{b.desc}</div></div>
                        <div className="side">
                          {side}
                          <Switch label={`Use ${b.name}`} title={enabled ? `Turn off ${b.name}` : `Turn on ${b.name}`} checked={enabled}
                            onChange={(v) => save({ integrations: { ...c.integrations, [b.key]: v } })} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <h2>claude.ai connectors &amp; MCP servers</h2>
                <p className="sub">Loaded by Claude Code from your account and settings.</p>
                <div className="card list">
                  {!info && !liveConnectors ? (
                    <div className="item"><div className="ic">⏳</div><div className="main"><Skeleton widths={["w40", "w60"]} /></div><div className="side" /></div>
                  ) : connectors().length === 0 ? (
                    <div className="empty-line">
                      {infoError ? `Couldn't load connectors: ${infoError}` : "No connectors yet."}
                      <button type="button" className="btn small" onClick={() => openTarget("connectors")}>Add connectors on claude.ai</button>
                    </div>
                  ) : (
                    connectors().map((cn) => {
                      const isClaudeAi = cn.source === "claudeai" || cn.name.startsWith("claude.ai ");
                      return (
                        <div key={cn.name} className="item">
                          <div className="ic" aria-hidden="true">{isClaudeAi ? "☁️" : "🧩"}</div>
                          <div className="main">
                            <div className="name">{cn.name.replace(/^claude\.ai /, "")}</div>
                            <div className="desc">{isClaudeAi ? "claude.ai connector" : (c.mcpServers || {})[cn.name] ? "Sidekick custom server" : "Claude Code MCP server"}</div>
                          </div>
                          <div className="side">
                            <StatusPill status={cn.status} />
                            {cn.status === "needs-auth" && <button type="button" className="btn small" onClick={() => mcpLogin(cn.name)}>Authorize</button>}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <h2>Custom MCP servers</h2>
                <p className="sub">Extra servers that only Sidekick's Claude Code uses.</p>
                <div className="card list">
                  {Object.keys(c.mcpServers || {}).length === 0 ? (
                    <div className="empty-line">No custom servers yet.</div>
                  ) : (
                    Object.entries(c.mcpServers).map(([name, s]) => {
                      const tools = c.extraAllowedTools || [];
                      const live = connectors().find((x) => x.name === name);
                      return (
                        <div key={name} className="item">
                          <div className="ic" aria-hidden="true">{s.type === "http" ? "🌐" : "🧩"}</div>
                          <div className="main">
                            <div className="name">
                              {name}
                              <span className="tag">{s.type === "http" ? "HTTP" : "stdio"}</span>
                              {tools.includes(`mcp__${name}`) && <span className="tag accent">auto-approved</span>}
                            </div>
                            <div className="desc mono">{serverSummary(s)}</div>
                          </div>
                          <div className="side">
                            {live && <StatusPill status={live.status} />}
                            <button type="button" className="btn small danger" onClick={() => {
                              if (!confirm(`Remove the MCP server "${name}"?`)) return;
                              const next = { ...c.mcpServers };
                              delete next[name];
                              void save({ mcpServers: next, extraAllowedTools: tools.filter((t) => t !== `mcp__${name}` && !t.startsWith(`mcp__${name}__`)) });
                            }}>Remove</button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <details className="card add" open={addOpen} onToggle={(e) => setAddOpen((e.target as HTMLDetailsElement).open)}>
                  <summary>＋ Add server</summary>
                  <form className="form" noValidate onSubmit={addServer}>
                    <div className="grid2">
                      <label className="f">Name
                        <input className="input mono" autoComplete="off" spellCheck={false} placeholder="notion" maxLength={40} required value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
                      </label>
                      <fieldset className="f">
                        <legend>Type</legend>
                        <div className="seg radios">
                          <label><input type="radio" name="mcpType" value="stdio" checked={mcpType === "stdio"} onChange={() => setMcpType("stdio")} /><span>Command (stdio)</span></label>
                          <label><input type="radio" name="mcpType" value="http" checked={mcpType === "http"} onChange={() => setMcpType("http")} /><span>URL (HTTP)</span></label>
                        </div>
                      </fieldset>
                    </div>
                    <div hidden={mcpType === "http"}>
                      <label className="f">Command
                        <input className="input mono" autoComplete="off" spellCheck={false} placeholder="npx" value={mcpCommand} onChange={(e) => setMcpCommand(e.target.value)} />
                      </label>
                      <label className="f">Arguments <small>space-separated, use quotes for spaces</small>
                        <input className="input mono" autoComplete="off" spellCheck={false} placeholder={'-y @modelcontextprotocol/server-filesystem "C:\\Users\\me\\Notes"'} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} />
                      </label>
                    </div>
                    <div hidden={mcpType !== "http"}>
                      <label className="f">URL
                        <input className="input mono" autoComplete="off" spellCheck={false} placeholder="https://example.com/mcp" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} />
                      </label>
                    </div>
                    <label className="f"><span>{mcpType === "http" ? "Headers" : "Environment variables"}</span> <small>{mcpType === "http" ? "optional, Name: value, one per line" : "optional, KEY=VALUE, one per line"}</small>
                      <textarea className="input mono" rows={3} spellCheck={false} placeholder={mcpType === "http" ? "Authorization: Bearer …" : "API_KEY=…"} value={mcpKV} onChange={(e) => setMcpKV(e.target.value)} />
                    </label>
                    <label className="check"><input type="checkbox" checked={mcpAuto} onChange={(e) => setMcpAuto(e.target.checked)} /> Auto-approve its tools <small>(Claude can use them without asking)</small></label>
                    <p className="field-err" role="alert" hidden={!mcpErr}>{mcpErr}</p>
                    <div className="btn-row"><button type="submit" className="btn primary">Add server</button></div>
                  </form>
                </details>

                <h2>YouTube channels</h2>
                <div className="card pad">
                  <p className="sub tight">Sidekick checks these for new videos when it syncs.</p>
                  <Chips label="Followed channels" empty="No channels yet." items={c.youtubeChannels || []}
                    onRemove={(item) => save({ youtubeChannels: (c.youtubeChannels || []).filter((x) => x !== item) })} />
                  <form className="chip-add" onSubmit={addChannel}>
                    <input className="input" autoComplete="off" spellCheck={false} placeholder="@channel or channel URL" aria-label="Add a YouTube channel" value={ytInput} onChange={(e) => setYtInput(e.target.value)} />
                    <button type="submit" className="btn">Add</button>
                  </form>
                </div>

                <h2>Advanced</h2>
                <div className="card pad">
                  <div className="label">Auto-approved tools<small>Tools Claude may use without asking, e.g. <code>mcp__notion</code>. Built-in Sidekick tools, web search and your Gmail/Calendar connectors are already allowed.</small></div>
                  <Chips label="Auto-approved tools" empty="None." items={c.extraAllowedTools || []}
                    onRemove={(item) => save({ extraAllowedTools: (c.extraAllowedTools || []).filter((t) => t !== item) })} />
                  <form className="chip-add" onSubmit={addTool}>
                    <input className="input mono" autoComplete="off" spellCheck={false} placeholder="mcp__server or mcp__server__tool" aria-label="Add an auto-approved tool" value={toolInput} onChange={(e) => setToolInput(e.target.value)} />
                    <button type="submit" className="btn">Add</button>
                  </form>
                </div>
              </>
            )}
          </section>

          {/* ===================== Mascot ===================== */}
          <section id="panel-mascot" className="panel" role="tabpanel" aria-labelledby="tab-mascot" tabIndex={0} hidden={tab !== "mascot"}>
            <h1>Mascot &amp; alerts</h1>
            <p className="lede">Your little desktop buddy and its notifier bubble.</p>
            {ready && (
              <>
                <div className="card">
                  <div className="row">
                    <label className="label" htmlFor="mascotVisible">Show mascot<small>Hide it to keep only the tray icon.</small></label>
                    <Switch id="mascotVisible" checked={c!.mascotVisible} onChange={(v) => save({ mascotVisible: v })} />
                  </div>
                  <div className="row">
                    <div className="label"><span id="lbl-size">Size</span></div>
                    <Seg label="lbl-size" items={o!.mascotSizes.map((id) => ({ id, label: SIZE_LABEL[id] || id }))} current={c!.mascotSize} onPick={(v) => save({ mascotSize: v })} />
                  </div>
                  <div className="row">
                    <label className="label" htmlFor="sleepAfter">Nap after<small>Minutes of quiet before it dozes off. 0 = never.</small></label>
                    <div className="suffix">
                      <input type="number" id="sleepAfter" className="input narrow" min={0} max={240} step={1} value={sleepAfter} {...sleepFocus}
                        onChange={(e) => { const v = e.target.value; setSleepAfter(v); const n = clampNum(v, 0, 240); if (n !== null) saveLater("sleepAfter", () => ({ sleepAfterMinutes: n }), 600); }}
                        onBlur={() => { sleepFocus.onBlur(); const n = clampNum(sleepAfter, 0, 240); if (n !== null) setSleepAfter(String(n)); }} />
                      <span>min</span>
                    </div>
                  </div>
                </div>

                <h2>Notifier</h2>
                <div className="card">
                  <div className="row">
                    <label className="label" htmlFor="notifierAuto">Pop up on new alerts<small>Reminders, sync results and new tasks show in a bubble next to the mascot.</small></label>
                    <Switch id="notifierAuto" checked={c!.notifier.autoShow} onChange={(v) => save({ notifier: { ...c!.notifier, autoShow: v } })} />
                  </div>
                  <div className="row">
                    <label className="label" htmlFor="notifierHide">Hide the bubble after<small>It stays open while your mouse is over it.</small></label>
                    <div className="suffix">
                      <input type="number" id="notifierHide" className="input narrow" min={3} max={120} step={1} value={hideAfter} {...hideFocus}
                        onChange={(e) => {
                          const v = e.target.value;
                          setHideAfter(v);
                          const n = clampNum(v, 3, 120);
                          if (n !== null) saveLater("notifierHide", () => ({ notifier: { ...(configRef.current?.notifier || c!.notifier), hideAfterSeconds: n } }), 600);
                        }}
                        onBlur={() => { hideFocus.onBlur(); const n = clampNum(hideAfter, 3, 120); if (n !== null) setHideAfter(String(n)); }} />
                      <span>sec</span>
                    </div>
                  </div>
                </div>

                <div className="card tip">
                  <span className="tip-ic" aria-hidden="true">🎨</span>
                  <div>
                    <div className="label">Custom look<small>Put an image named <code>mascot.png</code>, <code>mascot.gif</code> or <code>mascot.webp</code> (about 120×120, transparent background) in the data folder, then restart Sidekick.</small></div>
                    <button type="button" className="btn small" onClick={() => openTarget("dataFolder")}>Open data folder</button>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ===================== About ===================== */}
          <section id="panel-about" className="panel" role="tabpanel" aria-labelledby="tab-about" tabIndex={0} hidden={tab !== "about"}>
            <div className="hero">
              <svg className="hero-mark" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 1 Q13.7 10.3 23 12 Q13.7 13.7 12 23 Q10.3 13.7 1 12 Q10.3 10.3 12 1Z" />
              </svg>
              <div>
                <h1>{info?.app?.name || "Sidekick"}</h1>
                <p className="muted">{info ? `Version ${info.app?.version || "unknown"}` : infoError ? "Version unknown" : "Version …"}</p>
              </div>
            </div>
            <p className="lede">A desktop companion that runs on your own Claude Code login.</p>
            <div className="card">
              <dl className="details wide">
                {!info && !infoError && <Skeleton widths={["w40", "w60", "w80", "w60", "w40"]} />}
                {!info && infoError && <><dt>Error</dt><dd>{infoError}</dd></>}
                {info && ([
                  ["Version", info.app?.version],
                  ["Tauri", info.app?.tauri],
                  ["WebView2", info.app?.webview || "—"],
                  ["Platform", [info.app?.platform, info.app?.arch].filter(Boolean).join(" ")],
                  ["Claude Code", info.claude?.found ? (info.claude.version ? `v${info.claude.version.replace(/^v/, "")}` : "found") : "Not found"],
                  ["Claude Code path", info.claude?.path, true],
                  ["GitHub CLI", ghText(info.github)],
                  ["Data folder", info.dataDir, true],
                ] as [string, string | null | undefined, boolean?][]).filter(([, v]) => v).map(([k, v, mono]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd className={mono ? "mono" : undefined}>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
            <div className="btn-row">
              <button type="button" className="btn" onClick={() => openTarget("dataFolder")}>Open data folder</button>
              <button type="button" className="btn" onClick={copyDiagnostics}>Copy diagnostics</button>
            </div>
            <p className="fine">Diagnostics include versions, statuses and settings, but no email address or account names.</p>
          </section>
        </main>
      </div>

      <div className={`toast${toast ? ` ${toast.kind}` : ""}`} role="status" aria-live="polite" hidden={!toast}>{toast?.msg}</div>
    </>
  );
}
