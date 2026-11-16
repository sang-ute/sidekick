// The desktop pet and its notifier (a chat-bubble mini dashboard). Reacts to what Claude
// Code is doing; the Rust shell handles dragging, click-through and opening windows.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, shell } from "../lib/api";
import { ago, applyTheme, until } from "../lib/dom";
import { onShell, subscribe } from "../lib/events";
import type { Config, Reminder, SidekickNotification, Task } from "../lib/types";

const MOODS = ["idle", "thinking", "fetching", "talking", "happy", "alert", "sad", "sleeping"] as const;
type Mood = (typeof MOODS)[number];
const FETCH_TOOL = /github|youtube|gmail|calendar|claude_ai|web|fetch|search/i;
const KIND_ICON: Record<string, string> = { reminder: "⏰", sync: "🔄", task: "📌", error: "⚠️", info: "💡" };
const SCALE: Record<string, number> = { small: 0.8, medium: 1, large: 1.25 };
const DEFAULTS = { sleepAfterMinutes: 10, notifier: { autoShow: true, hideAfterSeconds: 12 } };

// Set by the shell for screenshots: a mood name, or "notifier" (sample data, card stays open).
const DEMO: string = (window as unknown as { __SIDEKICK_DEMO__?: string | null }).__SIDEKICK_DEMO__ || "";
const demoMood = (MOODS as readonly string[]).includes(DEMO) ? (DEMO as Mood) : null;

function applyScale(c: Partial<Config> | null) {
  document.documentElement.style.setProperty("--scale", String(SCALE[c?.mascotSize || "medium"] || 1));
}

export function Mascot() {
  // ---------- state ----------
  const [mood, setMoodState] = useState<Mood>(demoMood || "idle");
  const [hop, setHop] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notifications, setNotifications] = useState<SidekickNotification[]>([]);
  const [skin, setSkin] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [line, setLineText] = useState("");
  const [lineHidden, setLineHidden] = useState(true);
  const [nStatus, setNStatus] = useState("");
  const [, setTick] = useState(0); // re-render relative times

  // Mutable values the event handlers read (they're set up once).
  const r = useRef({
    mood: (demoMood || "idle") as Mood,
    config: null as Partial<Config> | null,
    panelOpen: false,
    cardOpen: false,
    overCard: false,
    lastActivity: Date.now(),
    replyPreview: "",
    dragging: false,
    timers: { mood: 0, hide: 0, line: 0, hover: 0 } as Record<"mood" | "hide" | "line" | "hover", number>,
    drag: null as null | { x: number; y: number; moved: boolean },
  }).current;
  const petRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  // ---------- behaviour (stable functions over the refs) ----------
  const ctl = useMemo(() => {
    const notifierCfg = () => ({ ...DEFAULTS.notifier, ...(r.config?.notifier || {}) });
    const setMood = (next: Mood, ms?: number) => {
      if (demoMood && next !== demoMood) return; // demo locks the mood
      clearTimeout(r.timers.mood);
      r.mood = next;
      setMoodState(next);
      if (next !== "sleeping") r.lastActivity = Date.now();
      if (ms) r.timers.mood = window.setTimeout(() => setMood("idle"), ms);
    };
    const scheduleHide = () => {
      clearTimeout(r.timers.hide);
      if (DEMO === "notifier") return;
      const secs = Number(notifierCfg().hideAfterSeconds) || 12;
      r.timers.hide = window.setTimeout(() => { if (!r.overCard) hideNotifier(); }, secs * 1000);
    };
    const showNotifier = () => {
      if (r.panelOpen && DEMO !== "notifier") return; // the chat window is open beside us
      r.cardOpen = true;
      setCardOpen(true);
      scheduleHide();
    };
    const hideNotifier = () => {
      clearTimeout(r.timers.hide);
      if (DEMO === "notifier") return;
      r.cardOpen = false;
      setCardOpen(false);
      setLine("");
    };
    /** Short message at the top of the card (greeting, reply preview, busy status). */
    const setLine = (text: string, { show = false, ms = 0 } = {}) => {
      clearTimeout(r.timers.line);
      setLineText(text);
      setLineHidden(!text);
      if (text && show) showNotifier();
      if (text && ms) r.timers.line = window.setTimeout(() => setLineHidden(true), ms);
    };
    const addNotification = (n: SidekickNotification) => {
      if (!n || !n.id) return;
      setNotifications((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 50));
      if (notifierCfg().autoShow) showNotifier();
    };
    const applyConfig = (c: Partial<Config> | null) => {
      r.config = c || {};
      applyTheme(c as Config);
      applyScale(c);
    };
    return { setMood, showNotifier, hideNotifier, setLine, addNotification, applyConfig };
  }, [r]);

  // ---------- idle life: hop now and then, nap after `sleepAfterMinutes` ----------
  useEffect(() => {
    const id = window.setInterval(() => {
      const sleepMin = Number(r.config?.sleepAfterMinutes ?? DEFAULTS.sleepAfterMinutes) || 0;
      if (r.mood === "idle" && sleepMin > 0 && Date.now() - r.lastActivity > sleepMin * 60_000) {
        ctl.setMood("sleeping");
        return;
      }
      if (r.mood === "idle" && Math.random() < 0.35) {
        setHop(false);
        requestAnimationFrame(() => setHop(true)); // restart the animation
      }
    }, 20_000);
    return () => clearInterval(id);
  }, [ctl, r]);

  // ---------- eyes follow the cursor (offset comes from the shell) ----------
  useEffect(() => onShell<{ dx: number; dy: number }>("pet-cursor", ({ dx, dy }) => {
    if (r.mood === "sleeping") {
      if (Math.hypot(dx, dy) < 120) ctl.setMood("idle"); // wake up when you come close
      return;
    }
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 300);
    const x = (dx / d) * 4 * k;
    const y = (dy / d) * 3 * k - (r.mood === "thinking" ? 3 : 0);
    if (eyesRef.current) eyesRef.current.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }), [ctl, r]);

  // ---------- chat window open/closed ----------
  useEffect(() => onShell<boolean>("panel-state", (open) => {
    r.panelOpen = open;
    if (open) ctl.hideNotifier();
  }), [ctl, r]);

  // ---------- refresh relative times while the card is open ----------
  useEffect(() => {
    const id = window.setInterval(() => { if (r.cardOpen) setTick((t) => t + 1); }, 30_000);
    return () => clearInterval(id);
  }, [r]);

  // ---------- react to Claude Code (or play the demo) ----------
  useEffect(() => {
    if (DEMO) {
      const min = 60_000;
      const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
      ctl.applyConfig({});
      setTasks([{ id: "a", done: false }, { id: "b", done: false }, { id: "c", done: false }, { id: "d", done: true }] as Task[]);
      setReminders([{ id: "r1", text: "Stand up and stretch", dueAt: iso(25 * min), repeat: "none", createdAt: iso(0) }]);
      setNotifications([
        { id: "n1", kind: "reminder", title: "Drink some water 💧", body: "Reminder you set at 14:05", link: "", at: iso(-2 * min) },
        { id: "n2", kind: "sync", title: "Sync done: 3 new tasks", body: "2 GitHub issues, 1 email needs a reply", link: "", at: iso(-18 * min) },
        { id: "n3", kind: "task", title: "Review PR #12 in portfolio-website", body: "GitHub · review requested", link: "https://github.com/", at: iso(-40 * min) },
        { id: "n4", kind: "error", title: "Gmail isn't connected", body: "Connect it at claude.ai → Settings → Connectors", link: "", at: iso(-3 * 60 * min) },
      ]);
      if (DEMO === "notifier") {
        ctl.setLine("Good morning! You have 3 tasks and a reminder in 25 minutes.");
        ctl.showNotifier();
      }
      return;
    }
    const greet = window.setTimeout(() => ctl.setLine("Hi! Click me to chat, drag me anywhere, hover for your dashboard. 👋", { show: true, ms: 8000 }), 800);
    const unsubscribe = subscribe({
      hello: (h) => {
        ctl.applyConfig(h.config);
        setTasks(h.tasks || []);
        setReminders(h.reminders || []);
        setNotifications(h.notifications || []);
        if (h.skin) api.skin().then(setSkin).catch(() => {});
        if (h.status?.state === "missing") {
          ctl.setMood("sad");
          ctl.setLine("I can't find Claude Code. Is it installed and signed in?", { show: true });
        }
      },
      config: (c) => ctl.applyConfig(c),
      tasks: (l) => setTasks(l || []),
      reminders: (l) => setReminders(l || []),
      notifications: (l) => setNotifications(l || []),
      notify: (n) => ctl.addNotification(n),
      user: () => {
        r.replyPreview = "";
        ctl.setMood("thinking");
        setNStatus("Thinking…");
        if (!r.panelOpen) ctl.setLine("Thinking…");
      },
      tool: (name) => {
        const fetching = FETCH_TOOL.test(String(name || ""));
        ctl.setMood(fetching ? "fetching" : "thinking");
        setNStatus(fetching ? "Fetching data…" : "Working…");
        if (!r.panelOpen && r.cardOpen) ctl.setLine(fetching ? "Fetching data…" : "Working on it…");
      },
      delta: (t) => {
        r.replyPreview += t;
        if (r.mood !== "talking") { ctl.setMood("talking"); setNStatus("Answering…"); }
      },
      done: () => {
        setNStatus("");
        ctl.setMood("happy", 1500);
        // If the chat is closed, show the start of the answer in the card.
        const text = r.replyPreview.trim();
        if (!r.panelOpen && text) ctl.setLine(text.length > 140 ? text.slice(0, 137) + "…" : text, { show: true });
        else ctl.setLine("");
      },
      failure: (msg) => {
        setNStatus("");
        ctl.setMood("sad", 4000);
        if (!r.panelOpen) {
          const m = String(msg || "Something went wrong.");
          ctl.setLine(`⚠️ ${m.length > 120 ? m.slice(0, 117) + "…" : m}`, { show: true });
        }
      },
      reminder: (rem) => {
        ctl.setMood("alert", 15000);
        ctl.setLine(`⏰ ${rem.text}`, { show: true });
      },
      status: (s) => { if (s.state === "missing") ctl.setMood("sad"); },
    });
    return () => { clearTimeout(greet); unsubscribe(); };
  }, [ctl, r]);

  // ---------- click-through: tell the shell which parts catch the mouse ----------
  const lastRects = useRef("");
  useLayoutEffect(() => {
    const report = () => {
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (const el of [petRef.current, badgeRef.current, cardRef.current]) {
        if (!el || (el as HTMLElement).hidden) continue;
        const b = el.getBoundingClientRect();
        if (b.width && b.height) rects.push({ x: b.left, y: b.top, w: b.width, h: b.height });
      }
      const key = JSON.stringify(rects.map((x) => [x.x, x.y, x.w, x.h].map(Math.round)));
      if (key !== lastRects.current) {
        lastRects.current = key;
        shell.hitRects(rects).catch(() => {});
      }
    };
    report();
    const id = window.setInterval(report, 500); // follows size changes and the pop-in animation
    window.addEventListener("resize", report);
    return () => { clearInterval(id); window.removeEventListener("resize", report); };
  });

  // ---------- pointer: hover shows the card, drag moves, click opens the chat ----------
  const onPointerEnter = () => {
    clearTimeout(r.timers.hover);
    r.timers.hover = window.setTimeout(() => { if (!r.dragging && !r.cardOpen) ctl.showNotifier(); }, 600);
  };
  const onPointerLeave = () => clearTimeout(r.timers.hover);
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    clearTimeout(r.timers.hover);
    r.drag = { x: e.screenX, y: e.screenY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    shell.dragStart();
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = r.drag;
    if (!d) return;
    const dx = e.screenX - d.x;
    const dy = e.screenY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    r.dragging = true;
    setDragging(true);
    shell.dragMove(dx, dy);
  };
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = r.drag;
    if (!d) return;
    r.drag = null;
    r.dragging = false;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    shell.dragEnd();
    if (!d.moved) {
      if (r.mood === "sleeping" || r.mood === "alert") ctl.setMood("idle");
      ctl.hideNotifier();
      shell.togglePanel();
    }
  };

  // ---------- derived ----------
  const openCount = tasks.filter((t) => !t.done).length;
  const nextReminder = reminders.map((x) => x.dueAt).filter((d) => new Date(d).getTime() > Date.now() - 60_000).sort()[0];
  const lastSync = notifications.find((n) => n.kind === "sync");
  const petClass = ["pet", mood, hop && "hop", dragging && "dragging", skin && "has-skin"].filter(Boolean).join(" ");

  const dismiss = (id: string) => {
    setNotifications((l) => l.filter((n) => n.id !== id));
    if (!DEMO) api.deleteNotification(id).catch(() => {}); // the core's `notifications` event confirms
  };

  return (
    <>
      {/* Notifier: a chat-bubble mini dashboard above the mascot */}
      <section
        id="notifier"
        ref={cardRef}
        className="notifier"
        aria-live="polite"
        hidden={!cardOpen}
        onMouseEnter={() => { r.overCard = true; clearTimeout(r.timers.hide); }}
        onMouseLeave={() => {
          r.overCard = false;
          if (r.cardOpen && DEMO !== "notifier") {
            const secs = Number({ ...DEFAULTS.notifier, ...(r.config?.notifier || {}) }.hideAfterSeconds) || 12;
            clearTimeout(r.timers.hide);
            r.timers.hide = window.setTimeout(() => { if (!r.overCard) ctl.hideNotifier(); }, secs * 1000);
          }
        }}
      >
        <header className="n-head">
          <svg className="n-avatar" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="13" r="10" className="n-avatar-body" />
            <circle cx="8.6" cy="12.5" r="1.6" className="n-avatar-eye" />
            <circle cx="15.4" cy="12.5" r="1.6" className="n-avatar-eye" />
            <path d="M19 1.5 Q19.5 4.5 22.5 5 Q19.5 5.5 19 8.5 Q18.5 5.5 15.5 5 Q18.5 4.5 19 1.5Z" className="n-avatar-spark" />
          </svg>
          <strong className="n-name">Sidekick</strong>
          <span className="n-status">{nStatus}</span>
          <button className="n-icon" type="button" title="Settings" aria-label="Settings" onClick={() => { ctl.hideNotifier(); shell.openSettings(); }}>⚙</button>
          <button className="n-icon" type="button" title="Hide" aria-label="Hide" onClick={() => ctl.hideNotifier()}>×</button>
        </header>

        <p className="n-line" hidden={lineHidden}>{line}</p>

        <div className="n-stats">
          <button className="chip" type="button" title="Open tasks" onClick={() => { ctl.hideNotifier(); shell.openPanel(); }}>
            📌 <b>{openCount}</b> <span>{openCount === 1 ? "task" : "tasks"}</span>
          </button>
          <span className="chip" title="Next reminder">⏰ <b>{nextReminder ? until(nextReminder) : "none"}</b></span>
          <span className="chip" title="Last sync">🔄 <b>{lastSync ? ago(lastSync.at) : "never"}</b></span>
        </div>

        <ul className="n-list">
          {notifications.slice(0, 30).map((n) => {
            const kind = KIND_ICON[n.kind] ? n.kind : "info";
            const hasLink = typeof n.link === "string" && /^https?:\/\//.test(n.link);
            const content = (
              <>
                <span className="n-ico">{KIND_ICON[n.kind] || KIND_ICON.info}</span>
                <div className="n-text">
                  <div className="n-title">{n.title || ""}</div>
                  {n.body && <div className="n-body">{n.body}</div>}
                </div>
                <span className="n-time">{n.at ? ago(n.at) : ""}</span>
              </>
            );
            return (
              <li key={n.id} className="n-item" data-kind={kind}>
                {hasLink ? (
                  <a className="n-row" href={n.link} target="_blank" rel="noopener noreferrer">{content}</a>
                ) : (
                  <div className="n-row" onClick={() => { ctl.hideNotifier(); shell.openPanel(); }}>{content}</div>
                )}
                <button className="n-x" type="button" title="Dismiss" onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismiss(n.id); }}>×</button>
              </li>
            );
          })}
        </ul>
        <p className="n-empty" hidden={notifications.length > 0}>No notifications yet. I'll pin news here.</p>

        <footer className="n-foot">
          <button className="n-btn primary" type="button" onClick={() => { ctl.hideNotifier(); shell.openPanel(); }}>Open chat</button>
          <button
            className="n-btn"
            type="button"
            disabled={notifications.length === 0}
            onClick={() => { setNotifications([]); if (!DEMO) api.clearNotifications().catch(() => {}); }}
          >Clear</button>
        </footer>
      </section>

      <div
        id="pet"
        ref={petRef}
        className={petClass}
        title="Click to chat · drag to move · right-click for menu"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => { e.preventDefault(); shell.showMenu(); }}
        onAnimationEnd={(e) => { if (e.animationName === "hop") setHop(false); }}
      >
        <svg viewBox="0 0 120 124" width="120" height="124" aria-hidden="true">
          <defs>
            <linearGradient id="skin" x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0" stopColor="#8fd0ff" />
              <stop offset="1" stopColor="#2f7fd8" />
            </linearGradient>
            <linearGradient id="sparkFill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="1" stopColor="#cfe8ff" />
            </linearGradient>
            <radialGradient id="glow">
              <stop offset="0" stopColor="#e6f9ff" />
              <stop offset="1" stopColor="#9fe3ff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="bellFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffe28a" />
              <stop offset="1" stopColor="#f2b632" />
            </linearGradient>
          </defs>

          <ellipse className="shadow" cx="60" cy="117" rx="30" ry="5" />

          <g className="body">
            {/* legs */}
            <rect className="leg legL" x="40" y="96" width="12" height="14" rx="6" />
            <rect className="leg legR" x="68" y="96" width="12" height="14" rx="6" />
            {/* arms */}
            <ellipse className="arm armL" cx="20" cy="74" rx="7" ry="11" />
            <ellipse className="arm armR" cx="100" cy="74" rx="7" ry="11" />

            {/* antenna */}
            <path className="stem" d="M60 34 Q58 24 62 16" />
            <g className="waves">
              <circle cx="62" cy="14" r="9" /><circle cx="62" cy="14" r="9" /><circle cx="62" cy="14" r="9" />
            </g>
            <g className="data">
              <circle cx="62" cy="14" r="2.3" /><circle cx="62" cy="14" r="2" />
              <circle cx="62" cy="14" r="2.3" /><circle cx="62" cy="14" r="1.8" />
            </g>
            <circle className="spark-glow" cx="62" cy="14" r="13" fill="url(#glow)" />
            <path className="spark" fill="url(#sparkFill)" d="M62 4 Q63.6 12.4 72 14 Q63.6 15.6 62 24 Q60.4 15.6 52 14 Q60.4 12.4 62 4Z" />

            {/* body */}
            <rect x="18" y="32" width="84" height="72" rx="32" fill="url(#skin)" />
            <ellipse className="belly" cx="60" cy="86" rx="24" ry="13" />

            {/* face */}
            <g className="eyes" ref={eyesRef}>
              <g className="eye"><ellipse cx="46" cy="62" rx="6.5" ry="8.5" /><circle className="shine" cx="48.5" cy="58.5" r="2.4" /></g>
              <g className="eye"><ellipse cx="74" cy="62" rx="6.5" ry="8.5" /><circle className="shine" cx="76.5" cy="58.5" r="2.4" /></g>
              <path className="lid lidL" d="M39 63 Q46 68 53 63" />
              <path className="lid lidR" d="M67 63 Q74 68 81 63" />
            </g>
            <ellipse className="cheek" cx="35" cy="75" rx="6" ry="3.5" />
            <ellipse className="cheek" cx="85" cy="75" rx="6" ry="3.5" />
            <path className="mouth smile" d="M54 76 Q60 82 66 76" />
            <ellipse className="mouth talk" cx="60" cy="79" rx="4.5" ry="3.5" />
            <path className="mouth sad" d="M55 80 Q60 75 65 80" />
            <ellipse className="mouth oh" cx="60" cy="79" rx="3" ry="3.6" />

            {/* reminder bell, held in the right hand */}
            <g className="bell">
              <circle cx="115" cy="57" r="2.2" className="bell-ring-top" />
              <path d="M107 70 Q107 60 115 60 Q123 60 123 70 L125 73 L105 73 Z" fill="url(#bellFill)" className="bell-body" />
              <circle cx="115" cy="75.5" r="2" className="bell-clapper" />
            </g>
            <g className="rings">
              <path d="M128 60 Q132 66 128 72" /><path d="M132 56 Q138 66 132 76" />
            </g>
          </g>

          {/* "!" pop for reminders */}
          <g className="exclaim">
            <circle cx="22" cy="14" r="9" />
            <rect x="20.6" y="8" width="2.8" height="7.4" rx="1.4" />
            <circle cx="22" cy="18.8" r="1.6" />
          </g>

          <g className="zzz"><text x="88" y="30">z</text><text x="98" y="18">z</text></g>
          <g className="dots"><circle cx="86" cy="22" r="3" /><circle cx="96" cy="16" r="3" /><circle cx="106" cy="10" r="3" /></g>
        </svg>
        {/* custom skin: mascot.png / .gif / .webp in the data folder */}
        <img className="skin" alt="" src={skin || undefined} hidden={!skin} />
        <button
          ref={badgeRef}
          className="tasks-badge"
          type="button"
          title="Show notifications"
          hidden={openCount === 0}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); if (r.cardOpen) ctl.hideNotifier(); else ctl.showNotifier(); }}
        >{openCount}</button>
      </div>
    </>
  );
}
