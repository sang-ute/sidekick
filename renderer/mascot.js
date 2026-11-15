// The desktop pet + its notifier (a chat-bubble mini dashboard).
// Listens to the local server's event stream to react to what Claude Code is doing,
// and talks to the Electron shell for dragging, click-through and opening windows.
// All dynamic text goes in through textContent, never innerHTML.
const shellApi = window.sidekickShell || {
  // Fallbacks so the page doesn't crash if opened in a plain browser tab.
  togglePanel() {}, openPanel() {}, closePanel() {}, onPanel() {}, dragStart() {}, dragMove() {}, dragEnd() {},
  setInteractive() {}, showMenu() {}, onCursor() {}, openSettings() {},
};
const $ = (id) => document.getElementById(id);
const pet = $("pet");
const eyes = pet.querySelector(".eyes");
const card = $("notifier");

const params = new URLSearchParams(location.hash.slice(1));
const TOKEN = params.get("t") || "";
const DEMO = params.get("demo") || ""; // a mood name, or "notifier" (screenshots/testing)

const api = (method, url) =>
  fetch(url, { method, headers: { "x-sidekick-token": TOKEN } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

// ---------- state ----------
const MOODS = ["idle", "thinking", "fetching", "talking", "happy", "alert", "sad", "sleeping"];
const FETCH_TOOL = /github|youtube|gmail|calendar|claude_ai|web|fetch|search/i;
const state = {
  mood: "idle",
  tasks: [],
  reminders: [],
  notifications: [], // newest first
  config: {},
  panelOpen: false,
  busy: false,
  lastActivity: Date.now(),
  replyPreview: "",
};
const DEFAULTS = { theme: "system", mascotSize: "medium", sleepAfterMinutes: 10, notifier: { autoShow: true, hideAfterSeconds: 12 } };
const cfg = (key) => (state.config[key] ?? DEFAULTS[key]);
const notifierCfg = () => ({ ...DEFAULTS.notifier, ...(state.config.notifier || {}) });

// ---------- mood ----------
const demoMood = MOODS.includes(DEMO) ? DEMO : null;
let moodTimer = null;

function setMood(next, ms) {
  if (demoMood && next !== demoMood) return; // demo locks the mood
  clearTimeout(moodTimer);
  state.mood = next;
  pet.classList.remove(...MOODS);
  pet.classList.add(next);
  if (next !== "sleeping") state.lastActivity = Date.now();
  if (ms) moodTimer = setTimeout(() => setMood("idle"), ms);
}

// Idle life: hop now and then, fall asleep after `sleepAfterMinutes` quiet minutes.
setInterval(() => {
  const sleepMin = Number(cfg("sleepAfterMinutes")) || 0;
  if (state.mood === "idle" && sleepMin > 0 && Date.now() - state.lastActivity > sleepMin * 60_000) {
    return setMood("sleeping");
  }
  if (state.mood === "idle" && Math.random() < 0.35) {
    pet.classList.remove("hop");
    void pet.offsetWidth;
    pet.classList.add("hop");
  }
}, 20_000);
pet.addEventListener("animationend", (e) => { if (e.animationName === "hop") pet.classList.remove("hop"); });

// ---------- eyes follow the cursor (position comes from the main process) ----------
shellApi.onCursor(({ dx, dy }) => {
  if (state.mood === "sleeping") {
    if (Math.hypot(dx, dy) < 120) setMood("idle"); // wake up when you come close
    return;
  }
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 300);
  const x = (dx / d) * 4 * k;
  const y = (dy / d) * 3 * k - (state.mood === "thinking" ? 3 : 0);
  eyes.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
});

// ---------- config: theme + size ----------
const SCALE = { small: 0.8, medium: 1, large: 1.25 };
function applyConfig(config) {
  state.config = config || {};
  const theme = cfg("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.setProperty("--scale", String(SCALE[cfg("mascotSize")] || 1));
}

// ---------- relative times ----------
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return `${Math.round(s / 86400)}d ago`;
}
function until(iso) {
  const t = new Date(iso).getTime();
  const s = (t - Date.now()) / 1000;
  if (!Number.isFinite(s)) return "none";
  if (s < 60) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 6 * 3600) {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// ---------- notifier rendering ----------
const KIND_ICON = { reminder: "⏰", sync: "🔄", task: "📌", error: "⚠️", info: "💡" };

function renderStats() {
  const open = state.tasks.filter((t) => !t.done).length;
  $("statTasks").textContent = String(open);
  $("statTasksLabel").textContent = open === 1 ? "task" : "tasks";
  const next = state.reminders
    .map((r) => r.dueAt)
    .filter((d) => new Date(d).getTime() > Date.now() - 60_000)
    .sort()[0];
  $("statReminder").textContent = next ? until(next) : "none";
  const lastSync = state.notifications.find((n) => n.kind === "sync");
  $("statSync").textContent = lastSync ? ago(lastSync.at) : "never";

  const badge = $("tasksBadge");
  badge.textContent = String(open);
  badge.hidden = open === 0;
}

function itemEl(n) {
  const li = document.createElement("li");
  li.className = "n-item";
  li.dataset.kind = KIND_ICON[n.kind] ? n.kind : "info";

  const hasLink = typeof n.link === "string" && /^https?:\/\//.test(n.link);
  const row = document.createElement(hasLink ? "a" : "div");
  row.className = "n-row";
  if (hasLink) {
    row.href = n.link;
    row.target = "_blank"; // the shell opens it in the real browser
    row.rel = "noopener noreferrer";
  } else {
    row.addEventListener("click", () => { hideNotifier(); shellApi.openPanel(); });
  }

  const ico = document.createElement("span");
  ico.className = "n-ico";
  ico.textContent = KIND_ICON[n.kind] || KIND_ICON.info;
  const text = document.createElement("div");
  text.className = "n-text";
  const title = document.createElement("div");
  title.className = "n-title";
  title.textContent = n.title || "";
  text.appendChild(title);
  if (n.body) {
    const body = document.createElement("div");
    body.className = "n-body";
    body.textContent = n.body;
    text.appendChild(body);
  }
  const time = document.createElement("span");
  time.className = "n-time";
  time.textContent = n.at ? ago(n.at) : "";
  time.dataset.at = n.at || "";
  row.append(ico, text, time);

  const x = document.createElement("button");
  x.className = "n-x";
  x.type = "button";
  x.title = "Dismiss";
  x.textContent = "×";
  x.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (DEMO) { removeNotification(n.id); return; }
    api("DELETE", `/api/notifications/${encodeURIComponent(n.id)}`).catch(() => {});
    removeNotification(n.id); // optimistic; the server's `notifications` event confirms
  });

  li.append(row, x);
  return li;
}

function renderList() {
  $("nList").replaceChildren(...state.notifications.slice(0, 30).map(itemEl));
  $("nEmpty").hidden = state.notifications.length > 0;
  $("nClear").disabled = state.notifications.length === 0;
  renderStats();
}

function removeNotification(id) {
  state.notifications = state.notifications.filter((n) => n.id !== id);
  renderList();
}

// Refresh relative times while the card is open.
setInterval(() => {
  if (card.hidden) return;
  for (const el of card.querySelectorAll(".n-time")) if (el.dataset.at) el.textContent = ago(el.dataset.at);
  renderStats();
}, 30_000);

// ---------- notifier show / hide ----------
let hideTimer = null;
let overCard = false;

function scheduleHide() {
  clearTimeout(hideTimer);
  if (DEMO === "notifier") return;
  const secs = Number(notifierCfg().hideAfterSeconds) || 12;
  hideTimer = setTimeout(() => { if (!overCard) hideNotifier(); }, secs * 1000);
}
function showNotifier() {
  if (state.panelOpen && DEMO !== "notifier") return; // the chat window is open beside us
  renderList();
  card.hidden = false;
  scheduleHide();
}
function hideNotifier() {
  clearTimeout(hideTimer);
  if (DEMO === "notifier") return;
  card.hidden = true;
  setLine("");
}

let lineTimer = null;
/** Short message at the top of the card (greeting, reply preview, busy status). */
function setLine(text, { show = false, ms = 0 } = {}) {
  clearTimeout(lineTimer);
  const el = $("nLine");
  el.textContent = text;
  el.hidden = !text;
  if (text && show) showNotifier();
  if (text && ms) lineTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function setStatus(text) { $("nStatus").textContent = text; }

card.addEventListener("mouseenter", () => { overCard = true; clearTimeout(hideTimer); });
card.addEventListener("mouseleave", () => { overCard = false; if (!card.hidden) scheduleHide(); });
$("nClose").addEventListener("click", () => hideNotifier());
$("nGear").addEventListener("click", () => { hideNotifier(); shellApi.openSettings(); });
$("nOpen").addEventListener("click", () => { hideNotifier(); shellApi.openPanel(); });
$("nClear").addEventListener("click", () => {
  state.notifications = [];
  renderList();
  if (!DEMO) api("POST", "/api/notifications/clear").catch(() => {});
});
$("chipTasks").addEventListener("click", () => { hideNotifier(); shellApi.openPanel(); });

// Hovering the mascot for a moment shows the card.
let hoverTimer = null;
pet.addEventListener("mouseenter", () => {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { if (!dragging && card.hidden) showNotifier(); }, 600);
});
pet.addEventListener("mouseleave", () => clearTimeout(hoverTimer));

// The little task note on the mascot toggles the card (and doesn't start a drag/click).
const badge = $("tasksBadge");
badge.addEventListener("pointerdown", (e) => e.stopPropagation());
badge.addEventListener("click", (e) => {
  e.stopPropagation();
  card.hidden ? showNotifier() : hideNotifier();
});

// ---------- click-through outside the pet ----------
// The window is bigger than the pet (room for the notifier). Transparent parts pass
// clicks to the desktop; only the pet and the card catch the mouse.
let dragging = false;
for (const el of [pet, card]) {
  el.addEventListener("mouseenter", () => shellApi.setInteractive(true));
  el.addEventListener("mouseleave", () => { if (!dragging) shellApi.setInteractive(false); });
}

// ---------- drag to move, click to open chat ----------
let start = null;
pet.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  clearTimeout(hoverTimer);
  start = { x: e.screenX, y: e.screenY, moved: false };
  pet.setPointerCapture(e.pointerId);
  shellApi.dragStart();
});
pet.addEventListener("pointermove", (e) => {
  if (!start) return;
  const dx = e.screenX - start.x;
  const dy = e.screenY - start.y;
  if (!start.moved && Math.hypot(dx, dy) < 5) return;
  start.moved = true;
  dragging = true;
  pet.classList.add("dragging");
  shellApi.dragMove(dx, dy);
});
pet.addEventListener("pointerup", (e) => {
  if (!start) return;
  const wasDrag = start.moved;
  start = null;
  dragging = false;
  pet.classList.remove("dragging");
  if (pet.hasPointerCapture(e.pointerId)) pet.releasePointerCapture(e.pointerId);
  shellApi.dragEnd();
  if (!wasDrag) {
    if (state.mood === "sleeping" || state.mood === "alert") setMood("idle");
    hideNotifier();
    shellApi.togglePanel();
  }
});
pet.addEventListener("contextmenu", (e) => { e.preventDefault(); shellApi.showMenu(); });

shellApi.onPanel((open) => {
  state.panelOpen = open;
  if (open) hideNotifier();
});

// ---------- react to Claude Code ----------
function addNotification(n) {
  if (!n || !n.id) return;
  state.notifications = [n, ...state.notifications.filter((x) => x.id !== n.id)].slice(0, 50);
  renderList();
  if (notifierCfg().autoShow) showNotifier();
}

function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener("hello", (e) => {
    const h = JSON.parse(e.data);
    applyConfig(h.config);
    state.tasks = h.tasks || [];
    state.reminders = h.reminders || [];
    state.notifications = h.notifications || [];
    renderList();
    if (h.skin) useSkin();
    if (h.status && h.status.state === "missing") {
      setMood("sad");
      setLine("I can't find Claude Code. Is it installed and signed in?", { show: true });
    }
  });
  es.addEventListener("config", (e) => applyConfig(JSON.parse(e.data)));
  es.addEventListener("tasks", (e) => { state.tasks = JSON.parse(e.data) || []; renderStats(); });
  es.addEventListener("reminders", (e) => { state.reminders = JSON.parse(e.data) || []; renderStats(); });
  es.addEventListener("notifications", (e) => { state.notifications = JSON.parse(e.data) || []; renderList(); });
  es.addEventListener("notify", (e) => addNotification(JSON.parse(e.data)));

  es.addEventListener("user", () => {
    state.busy = true;
    state.replyPreview = "";
    setMood("thinking");
    setStatus("Thinking…");
    if (!state.panelOpen) setLine("Thinking…");
  });
  es.addEventListener("tool", (e) => {
    const name = String(JSON.parse(e.data) || "");
    const fetching = FETCH_TOOL.test(name);
    setMood(fetching ? "fetching" : "thinking");
    setStatus(fetching ? "Fetching data…" : "Working…");
    if (!state.panelOpen && !card.hidden) setLine(fetching ? "Fetching data…" : "Working on it…");
  });
  es.addEventListener("delta", (e) => {
    state.replyPreview += JSON.parse(e.data);
    if (state.mood !== "talking") { setMood("talking"); setStatus("Answering…"); }
  });
  es.addEventListener("done", () => {
    state.busy = false;
    setStatus("");
    setMood("happy", 1500);
    // If the chat is closed, show the start of the answer in the card.
    const text = state.replyPreview.trim();
    if (!state.panelOpen && text) setLine(text.length > 140 ? text.slice(0, 137) + "…" : text, { show: true });
    else setLine("");
  });
  es.addEventListener("failure", (e) => {
    state.busy = false;
    setStatus("");
    setMood("sad", 4000);
    if (!state.panelOpen) {
      const msg = String(JSON.parse(e.data) || "Something went wrong.");
      setLine(`⚠️ ${msg.length > 120 ? msg.slice(0, 117) + "…" : msg}`, { show: true });
    }
  });
  es.addEventListener("reminder", (e) => {
    const r = JSON.parse(e.data);
    setMood("alert", 15000);
    setLine(`⏰ ${r.text}`, { show: true });
  });
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    if (s.state === "missing") setMood("sad");
  });
}

function useSkin() {
  const img = $("skin");
  img.onload = () => { img.hidden = false; pet.classList.add("has-skin"); };
  img.src = "/skin?v=" + Date.now();
}

// ---------- demo mode (screenshots) ----------
function startDemo() {
  const min = 60_000;
  const iso = (offset) => new Date(Date.now() + offset).toISOString();
  applyConfig({});
  state.tasks = [{ id: "a", done: false }, { id: "b", done: false }, { id: "c", done: false }, { id: "d", done: true }];
  state.reminders = [{ id: "r1", text: "Stand up and stretch", dueAt: iso(25 * min), repeat: "none" }];
  state.notifications = [
    { id: "n1", kind: "reminder", title: "Drink some water 💧", body: "Reminder you set at 14:05", link: "", at: iso(-2 * min) },
    { id: "n2", kind: "sync", title: "Sync done: 3 new tasks", body: "2 GitHub issues, 1 email needs a reply", link: "", at: iso(-18 * min) },
    { id: "n3", kind: "task", title: "Review PR #12 in portfolio-website", body: "GitHub · review requested", link: "https://github.com/", at: iso(-40 * min) },
    { id: "n4", kind: "error", title: "Gmail isn't connected", body: "Connect it at claude.ai → Settings → Connectors", link: "", at: iso(-3 * 60 * min) },
  ];
  if (DEMO === "notifier") {
    setLine("Good morning! You have 3 tasks and a reminder in 25 minutes.");
    showNotifier();
  } else if (demoMood) {
    setMood(demoMood);
    renderStats();
  }
}

if (DEMO) {
  startDemo();
} else {
  connect();
  setTimeout(() => setLine("Hi! Click me to chat, drag me anywhere, hover for your dashboard. 👋", { show: true, ms: 8000 }), 800);
}
