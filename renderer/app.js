// UI for both the desktop bubble (Electron) and a plain browser tab.
// Talks to the local server; all text goes in via textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const shellApi = window.sidekickShell; // undefined in a normal browser
const els = {
  bubble: $("bubble"), badge: $("badge"), panel: $("panel"), status: $("status"), dot: $("dot"),
  chatView: $("chatView"), remView: $("remView"), missingView: $("missingView"),
  log: $("log"), input: $("chatInput"), send: $("sendBtn"),
};

// ---------- token (from #t=... in the URL, kept for this tab only) ----------
const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
if (hashToken) {
  sessionStorage.setItem("sidekick-token", hashToken);
  history.replaceState(null, "", location.pathname); // hide it from the address bar
}
const TOKEN = sessionStorage.getItem("sidekick-token") || "";

const api = (method, url, body) =>
  fetch(url, {
    method,
    headers: { "x-sidekick-token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

// ---------- layout ----------
let isExpanded = !shellApi;
let unread = 0;
let missing = false;

function applyExpanded() {
  els.bubble.hidden = isExpanded;
  els.panel.hidden = !isExpanded;
  if (isExpanded) {
    unread = 0;
    els.badge.hidden = true;
    els.bubble.classList.remove("alert");
    showView(missing ? "missing" : "chat");
  }
}
if (shellApi) {
  shellApi.onExpanded((v) => { isExpanded = v; applyExpanded(); });
} else {
  document.body.classList.add("browser");
  $("btnClose").hidden = true;
}
applyExpanded();

function showView(name) {
  els.chatView.hidden = name !== "chat";
  els.remView.hidden = name !== "rem";
  els.missingView.hidden = name !== "missing";
  if (name === "chat") els.input.focus();
  if (name === "rem") renderReminders();
}

els.bubble.addEventListener("click", () => shellApi?.toggle());
$("btnClose").addEventListener("click", () => shellApi?.collapse());
$("btnReminders").addEventListener("click", () => showView(els.remView.hidden ? "rem" : "chat"));
$("remBack").addEventListener("click", () => showView("chat"));
$("btnNew").addEventListener("click", () => api("POST", "/api/reset").catch(showErr));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") shellApi?.collapse(); });

// ---------- chat rendering ----------
let current = null; // bot message being streamed into
let busy = false;

function addMsg(kind, text = "") {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}
function greet() {
  els.log.replaceChildren();
  addMsg("bot", "Hi! I'm your sidekick, running on your Claude Code. Ask me anything, or say “remind me in 20 minutes to stretch”.");
}
function finishCurrent() {
  if (current) {
    current.classList.remove("thinking");
    current.textContent = current.textContent.trim();
    if (!current.textContent) current.remove();
  }
  current = null;
}
function setBusy(b) {
  busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
  if (!b && isExpanded) els.input.focus();
}
const showErr = (e) => addMsg("error", String(e.message || e));

const TOOL_LABEL = {
  mcp__sidekick__create_reminder: "⏰ setting a reminder…",
  mcp__sidekick__list_reminders: "📋 checking reminders…",
  mcp__sidekick__delete_reminder: "🗑 removing a reminder…",
  web_search: "🔎 searching the web…",
  WebSearch: "🔎 searching the web…",
  WebFetch: "🌐 reading a page…",
};

function apply(type, data, live) {
  switch (type) {
    case "user":
      finishCurrent();
      addMsg("user", data);
      current = addMsg("bot thinking");
      setBusy(true);
      break;
    case "delta":
      if (!current) current = addMsg("bot");
      current.classList.remove("thinking");
      current.textContent += data;
      els.log.scrollTop = els.log.scrollHeight;
      break;
    case "tool":
      finishCurrent();
      addMsg("note", TOOL_LABEL[data] || `using ${data.replace(/^mcp__/, "").replace(/__/g, " › ")}…`);
      current = addMsg("bot thinking");
      break;
    case "note":
      addMsg("note", data);
      break;
    case "done":
      finishCurrent();
      setBusy(false);
      break;
    case "error":
      finishCurrent();
      addMsg("error", data);
      setBusy(false);
      break;
    case "reminder":
      addMsg("note", `⏰ ${data.text}`);
      if (live && !isExpanded) {
        unread += 1;
        els.badge.textContent = String(unread);
        els.badge.hidden = false;
        els.bubble.classList.remove("alert");
        void els.bubble.offsetWidth; // restart the pulse
        els.bubble.classList.add("alert");
      }
      if (live && !shellApi && "Notification" in window && Notification.permission === "granted") {
        new Notification("Sidekick reminder", { body: data.text, icon: "/icon.png" });
      }
      if (!els.remView.hidden) renderReminders();
      break;
  }
}

function renderStatus(s) {
  missing = s.state === "missing";
  const connected = (s.connectors || [])
    .filter((c) => c.status === "connected" && c.name !== "sidekick")
    .map((c) => c.name.replace(/^claude\.ai /, ""));
  const label = {
    missing: "Claude Code not found",
    idle: "Claude Code · idle",
    starting: "Claude Code · starting…",
    ready: `Claude Code${s.model ? " · " + s.model.replace(/^claude-/, "") : ""}`,
    stopped: "Claude Code · sleeping (wakes on next message)",
  }[s.state] || s.state;
  els.status.textContent = label + (connected.length ? ` · ${connected.join(", ")}` : "");
  els.dot.dataset.state = s.state;
  if (missing && isExpanded) showView("missing");
}

// ---------- live connection ----------
function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener("hello", (e) => {
    const { status, history } = JSON.parse(e.data);
    greet();
    current = null;
    setBusy(false);
    for (const h of history) apply(h.type, h.data, false);
    renderStatus(status);
  });
  for (const t of ["user", "delta", "tool", "note", "done", "error", "reminder"]) {
    es.addEventListener(t, (e) => apply(t, JSON.parse(e.data), true));
  }
  es.addEventListener("status", (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener("reset", () => { greet(); current = null; setBusy(false); });
  es.onerror = () => {
    els.status.textContent = TOKEN ? "reconnecting…" : "no access token: open Sidekick from the tray menu";
    els.dot.dataset.state = "stopped";
  };
}
greet();
connect();

// ---------- composer ----------
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = "";
  autosize();
  api("POST", "/api/chat", { text }).catch(showErr);
  if (!shellApi && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); }
});
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}
els.input.addEventListener("input", autosize);

// ---------- reminders ----------
const fmt = (iso) => new Date(iso).toLocaleString(undefined, {
  weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
async function renderReminders() {
  const list = (await api("GET", "/api/reminders").catch(() => [])).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const ul = $("remList");
  ul.replaceChildren();
  $("remEmpty").hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.textContent = r.text;
    const when = document.createElement("small");
    when.textContent = fmt(r.dueAt) + (r.repeat && r.repeat !== "none" ? ` · ${r.repeat}` : "");
    info.appendChild(when);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", async () => { await api("DELETE", `/api/reminders/${r.id}`); renderReminders(); });
    li.append(info, del);
    ul.appendChild(li);
  }
}
