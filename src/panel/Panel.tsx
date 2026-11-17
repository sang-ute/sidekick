// The chat window that opens beside the mascot: task board, chat, reminders.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, shell } from "../lib/api";
import { applyTheme, fmt } from "../lib/dom";
import { onShell, subscribe } from "../lib/events";
import { Markdown } from "../lib/markdown";
import type { ChatEventType, HistoryItem, Reminder, Status, Task } from "../lib/types";

// ---------- chat log ----------
type Kind = "bot" | "user" | "note" | "error";
interface Msg { id: number; kind: Kind; text: string; thinking?: boolean; md?: boolean }
interface Chat { msgs: Msg[]; current: number | null; busy: boolean; seq: number }

const GREETING = "Hi! I'm your sidekick, running on your Claude Code. Ask me anything, or say “remind me in 20 minutes to stretch”.";
const greet = (): Chat => ({ msgs: [{ id: 0, kind: "bot", text: GREETING }], current: null, busy: false, seq: 1 });

const TOOL_LABEL: Record<string, string> = {
  mcp__sidekick__create_reminder: "⏰ setting a reminder…",
  mcp__sidekick__list_reminders: "📋 checking reminders…",
  mcp__sidekick__delete_reminder: "🗑 removing a reminder…",
  mcp__sidekick__add_task: "📌 pinning a task…",
  mcp__sidekick__list_tasks: "📋 reading the task board…",
  mcp__sidekick__complete_task: "✅ ticking off a task…",
  mcp__sidekick__delete_task: "🗑 removing a task…",
  mcp__sidekick__github_inbox: "🐙 checking GitHub…",
  mcp__sidekick__youtube_latest: "▶️ checking YouTube…",
  mcp__sidekick__youtube_follow: "▶️ updating your channels…",
  web_search: "🔎 searching the web…",
  WebSearch: "🔎 searching the web…",
  WebFetch: "🌐 reading a page…",
};

function add(s: Chat, kind: Kind, text = "", thinking = false): Chat {
  const m: Msg = { id: s.seq, kind, text, thinking };
  return { ...s, msgs: [...s.msgs, m], seq: s.seq + 1 };
}
/** Close the message being streamed: drop it if empty, otherwise format a bot reply. */
function finish(s: Chat): Chat {
  if (s.current === null) return s;
  const msgs = s.msgs
    .map((m) => {
      if (m.id !== s.current) return m;
      const text = m.text.trim();
      return text ? { ...m, thinking: false, text, md: m.kind === "bot" } : null;
    })
    .filter((m): m is Msg => m !== null);
  return { ...s, msgs, current: null };
}
function apply(s: Chat, type: ChatEventType, data: unknown): Chat {
  switch (type) {
    case "user": {
      const a = add(finish(s), "user", String(data));
      return { ...add(a, "bot", "", true), current: a.seq, busy: true };
    }
    case "delta": {
      let t = s;
      if (t.current === null) t = { ...add(t, "bot"), current: t.seq };
      return { ...t, msgs: t.msgs.map((m) => (m.id === t.current ? { ...m, thinking: false, text: m.text + String(data) } : m)) };
    }
    case "tool": {
      const name = String(data);
      const label = TOOL_LABEL[name] || `using ${name.replace(/^mcp__/, "").replace(/__/g, " › ")}…`;
      const a = add(finish(s), "note", label);
      return { ...add(a, "bot", "", true), current: a.seq };
    }
    case "note":
      return add(s, "note", String(data));
    case "done":
      return { ...finish(s), busy: false };
    case "failure":
      return { ...add(finish(s), "error", String(data)), busy: false };
    case "reminder":
      return add(s, "note", `⏰ ${(data as Reminder).text}`);
  }
  return s;
}
type Action = { t: "hello"; history: HistoryItem[] } | { t: "ev"; type: ChatEventType; data: unknown } | { t: "reset" } | { t: "error"; text: string };
function reducer(s: Chat, a: Action): Chat {
  switch (a.t) {
    case "hello": return a.history.reduce((acc, h) => apply(acc, h.type, h.data), greet());
    case "ev": return apply(s, a.type, a.data);
    case "reset": return greet();
    case "error": return add(s, "error", a.text);
    default: return s;
  }
}

// ---------- status line ----------
function statusLabel(s: Status): string {
  const connected = (s.connectors || []).filter((c) => c.status === "connected" && c.name !== "sidekick").map((c) => c.name.replace(/^claude\.ai /, ""));
  const label = {
    missing: "Claude Code not found",
    idle: "Claude Code · idle",
    starting: "Claude Code · starting…",
    ready: `Claude Code${s.model ? " · " + s.model.replace(/^claude-/, "") : ""}`,
    stopped: "Claude Code · sleeping (wakes on next message)",
  }[s.state] || s.state;
  return label + (connected.length ? ` · ${connected.join(", ")}` : "");
}

// ---------- task board ----------
const SOURCE_LABEL: Record<string, string> = { me: "✏️ you", gmail: "✉️ Gmail", github: "🐙 GitHub", youtube: "▶️ YouTube", calendar: "📅 Calendar", other: "📎" };

function Note({ t, onError }: { t: Task; onError: (e: unknown) => void }) {
  const overdue = !!t.due && !t.done && new Date(t.due) < new Date();
  return (
    <li className="note" data-source={t.source}>
      <input
        type="checkbox"
        checked={t.done}
        title={t.done ? "Mark not done" : "Mark done"}
        onChange={(e) => api.updateTask(t.id, { done: e.target.checked }).catch(onError)}
      />
      <div className="body">
        <div className="title">{t.title}</div>
        {t.notes && <div className="notes-line">{t.notes}</div>}
        <div className="meta">
          <span>{SOURCE_LABEL[t.source] || t.source}</span>
          {t.due && <span className={overdue ? "overdue" : undefined}>due {fmt(t.due)}</span>}
          {t.link && /^https?:\/\//.test(t.link) && (
            <a href={t.link} target="_blank" rel="noopener noreferrer">open ↗</a>
          )}
        </div>
      </div>
      <button className="x" title="Remove" onClick={() => api.deleteTask(t.id).catch(onError)}>✕</button>
    </li>
  );
}

type View = "tasks" | "chat" | "rem" | "missing";

export function Panel() {
  const [chat, dispatch] = useReducer(reducer, undefined, greet);
  const [status, setStatus] = useState<Status | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [view, setView] = useState<View>("tasks");
  const [input, setInput] = useState("");
  const [taskInput, setTaskInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const lastTab = useRef<"tasks" | "chat">("tasks");
  const missing = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const showErr = useCallback((e: unknown) => dispatch({ t: "error", text: e instanceof Error ? e.message : String(e) }), []);
  const loadReminders = useCallback(() => {
    api.reminders().then((l) => setReminders(l.toSorted((a, b) => a.dueAt.localeCompare(b.dueAt)))).catch(() => setReminders([]));
  }, []);

  const showView = useCallback((name: View) => {
    if (name === "tasks" || name === "chat") lastTab.current = name;
    if (name === "rem") loadReminders();
    setView(name);
  }, [loadReminders]);

  // ---------- live connection ----------
  useEffect(() => {
    return subscribe({
      hello: (h) => {
        applyTheme(h.config);
        dispatch({ t: "hello", history: h.history });
        setStatus(h.status);
        setTasks(h.tasks || []);
        setReminders((h.reminders || []).toSorted((a, b) => a.dueAt.localeCompare(b.dueAt)));
      },
      tasks: (l) => setTasks(l),
      reminders: (l) => setReminders(l.toSorted((a, b) => a.dueAt.localeCompare(b.dueAt))),
      config: (c) => applyTheme(c),
      status: (s) => setStatus(s),
      reset: () => dispatch({ t: "reset" }),
      user: (d) => dispatch({ t: "ev", type: "user", data: d }),
      delta: (d) => dispatch({ t: "ev", type: "delta", data: d }),
      tool: (d) => dispatch({ t: "ev", type: "tool", data: d }),
      note: (d) => dispatch({ t: "ev", type: "note", data: d }),
      done: (d) => dispatch({ t: "ev", type: "done", data: d }),
      failure: (d) => dispatch({ t: "ev", type: "failure", data: d }),
      reminder: (d) => dispatch({ t: "ev", type: "reminder", data: d }),
    });
  }, []);

  // Panel shown again: go back to the last tab (or the "not found" page).
  useEffect(() => onShell<boolean>("panel-state", (open) => {
    if (open) showView(missing.current ? "missing" : lastTab.current);
  }), [showView]);

  useEffect(() => {
    missing.current = status?.state === "missing";
    if (missing.current) setView("missing");
  }, [status]);

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") void shell.closePanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Keep the chat scrolled to the newest message, and focus the composer when it's usable.
  useLayoutEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat.msgs, view]);
  useEffect(() => {
    if (view === "chat" && !chat.busy) inputRef.current?.focus();
  }, [view, chat.busy]);

  // ---------- actions ----------
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || chat.busy) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    api.chat(text).catch(showErr);
  };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };
  const addTask = (e: FormEvent) => {
    e.preventDefault();
    const title = taskInput.trim();
    if (!title) return;
    setTaskInput("");
    api.addTask(title).catch(showErr);
  };
  const sync = async () => {
    setSyncing(true);
    try { await api.sync(); } catch (err) { showErr(err); } finally { setSyncing(false); }
  };

  const open = tasks.filter((t) => !t.done).toSorted((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || b.createdAt.localeCompare(a.createdAt));
  const done = tasks.filter((t) => t.done).toSorted((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));

  return (
    <section id="panel" className="panel">
      <header className="head" data-tauri-drag-region="deep">
        <div className="title">
          <span id="dot" className="dot" data-state={status?.state} />
          <div>
            Sidekick
            <small id="status" className="status">{status ? statusLabel(status) : "connecting…"}</small>
          </div>
        </div>
        <div className="actions">
          <button title="Reminders" aria-label="Reminders" onClick={() => showView(view === "rem" ? lastTab.current : "rem")}>⏰</button>
          <button title="Settings" aria-label="Settings" onClick={() => shell.openSettings()}>⚙</button>
          <button title="New chat" aria-label="New chat" onClick={() => api.reset().catch(showErr)}>＋</button>
          <button title="Collapse (Esc)" aria-label="Collapse" onClick={() => shell.closePanel()}>—</button>
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" className="tab" aria-selected={view === "tasks"} onClick={() => showView("tasks")}>
          📌 Tasks <span className="count" hidden={open.length === 0}>{open.length}</span>
        </button>
        <button role="tab" className="tab" aria-selected={view === "chat"} onClick={() => showView("chat")}>💬 Chat</button>
      </div>

      <div className="view board" hidden={view !== "tasks"}>
        <div className="board-head">
          <form className="task-add" onSubmit={addTask}>
            <input placeholder="Add a task…" autoComplete="off" maxLength={200} value={taskInput} onChange={(e) => setTaskInput(e.target.value)} />
          </form>
          <button className="sync" title="Check GitHub, Gmail and YouTube for new to-dos" disabled={chat.busy || syncing} onClick={sync}>🔄 Sync</button>
        </div>
        <ul className="notes">{open.map((t) => <Note key={t.id} t={t} onError={showErr} />)}</ul>
        <p className="muted empty" hidden={open.length > 0}>All clear ✨ Press <b>Sync</b> to pull to-dos from GitHub, Gmail and YouTube, or add one above.</p>
        <details className="done-box" hidden={done.length === 0}>
          <summary>Done ({done.length})</summary>
          <ul className="notes done">{done.map((t) => <Note key={t.id} t={t} onError={showErr} />)}</ul>
        </details>
      </div>

      <div className="view info" hidden={view !== "missing"}>
        <h2>Claude Code not found</h2>
        <p>Sidekick runs on your Claude Code login. Install Claude Code, run <code>claude</code> once in a terminal to sign in, then restart Sidekick from the tray.</p>
      </div>

      <div className="view chat" hidden={view !== "chat"}>
        <div ref={logRef} className="log" aria-live="polite">
          {chat.msgs.map((m) => (
            <div key={m.id} className={`msg ${m.kind}${m.thinking ? " thinking" : ""}${m.md ? " md" : ""}`}>
              {m.md ? <Markdown text={m.text} /> : m.text}
            </div>
          ))}
        </div>
        <form className="composer" onSubmit={send}>
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Message Sidekick…"
            value={input}
            disabled={chat.busy}
            onChange={(e) => { setInput(e.target.value); autosize(e.target); }}
            onKeyDown={onComposerKey}
          />
          <button type="submit" aria-label="Send" disabled={chat.busy}>➤</button>
        </form>
      </div>

      <div className="view info" hidden={view !== "rem"}>
        <h2>Reminders</h2>
        <ul id="remList">
          {reminders.map((r) => (
            <li key={r.id}>
              <div>
                {r.text}
                <small>{fmt(r.dueAt) + (r.repeat && r.repeat !== "none" ? ` · ${r.repeat}` : "")}</small>
              </div>
              <button title="Delete" onClick={() => api.deleteReminder(r.id).then(loadReminders).catch(showErr)}>✕</button>
            </li>
          ))}
        </ul>
        <p className="muted" hidden={reminders.length > 0}>Nothing scheduled. Ask in chat: “remind me tomorrow at 9 to apply to …”.</p>
        <button className="link" onClick={() => showView(lastTab.current)}>← Back to chat</button>
      </div>
    </section>
  );
}
