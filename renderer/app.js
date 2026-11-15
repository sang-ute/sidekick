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
// In the desktop app this page is the chat window that opens next to the mascot;
// in a browser it fills the tab.
const isExpanded = true;
let unread = 0;
let missing = false;

els.bubble.hidden = true;
els.panel.hidden = false;
let lastTab = "tasks";
if (shellApi) {
  shellApi.onPanel((open) => { if (open) showView(missing ? "missing" : lastTab); });
} else {
  document.body.classList.add("browser");
  $("btnClose").hidden = true;
}
setTimeout(() => showView("tasks"));

function showView(name) {
  els.chatView.hidden = name !== "chat";
  els.remView.hidden = name !== "rem";
  els.missingView.hidden = name !== "missing";
  $("tasksView").hidden = name !== "tasks";
  $("tabTasks").setAttribute("aria-selected", String(name === "tasks"));
  $("tabChat").setAttribute("aria-selected", String(name === "chat"));
  if (name === "tasks" || name === "chat") lastTab = name;
  if (name === "chat") { els.input.focus(); els.log.scrollTop = els.log.scrollHeight; }
  if (name === "rem") renderReminders();
}

$("btnSettings").addEventListener("click", () => {
  if (shellApi) shellApi.openSettings();
  else window.open(`/settings#t=${encodeURIComponent(TOKEN)}`, "_blank");
});

// Theme from Settings ("system" follows Windows).
function applyTheme(cfg) {
  if (cfg && (cfg.theme === "light" || cfg.theme === "dark")) document.documentElement.dataset.theme = cfg.theme;
  else delete document.documentElement.dataset.theme;
}

$("tabTasks").addEventListener("click", () => showView("tasks"));
$("tabChat").addEventListener("click", () => showView("chat"));
$("btnClose").addEventListener("click", () => shellApi?.closePanel());
$("btnReminders").addEventListener("click", () => showView(els.remView.hidden ? "rem" : lastTab));
$("remBack").addEventListener("click", () => showView(lastTab));
$("btnNew").addEventListener("click", () => api("POST", "/api/reset").catch(showErr));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") shellApi?.closePanel(); });

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
    const text = current.textContent.trim();
    if (!text) current.remove();
    else if (current.classList.contains("bot")) {
      current.replaceChildren(renderMarkdown(text)); // streamed as plain text, formatted when done
      current.classList.add("md");
    } else current.textContent = text;
    els.log.scrollTop = els.log.scrollHeight;
  }
  current = null;
}

// ---------- minimal, safe markdown (DOM nodes only, never innerHTML) ----------
// Paragraphs, line breaks, bullet/numbered lists, headings, **bold**, *italic*, `code`, [links](https://…).
function renderInline(text, parent) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    let el;
    if (m[1]) {
      el = document.createElement("code");
      el.textContent = tok.slice(1, -1);
    } else if (m[2]) {
      el = document.createElement("strong");
      renderInline(tok.slice(2, -2), el);
    } else if (m[3]) {
      el = document.createElement("a");
      el.href = m[4];
      el.target = "_blank"; // the app opens these in your real browser
      el.rel = "noopener noreferrer";
      el.textContent = tok.slice(1, tok.indexOf("]("));
    } else {
      el = document.createElement("em");
      renderInline(tok.slice(1, -1), el);
    }
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  let para = null;
  let list = null;
  const endBlocks = () => { para = null; list = null; };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { endBlocks(); continue; }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      endBlocks();
      const h = document.createElement("p");
      h.className = "h";
      renderInline(heading[1], h);
      frag.append(h);
      continue;
    }
    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      para = null;
      const tag = /\d/.test(item[1]) ? "OL" : "UL";
      if (!list || list.tagName !== tag) { list = document.createElement(tag); frag.append(list); }
      const li = document.createElement("li");
      renderInline(item[2], li);
      list.append(li);
      continue;
    }
    list = null;
    if (para) para.append(document.createElement("br"));
    else { para = document.createElement("p"); frag.append(para); }
    renderInline(line.trim(), para);
  }
  return frag;
}
function setBusy(b) {
  busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
  $("syncBtn").disabled = b;
  if (!b && !els.chatView.hidden) els.input.focus();
}
const showErr = (e) => addMsg("error", String(e.message || e));

const TOOL_LABEL = {
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
    case "failure":
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
    const { status, history, tasks, config } = JSON.parse(e.data);
    applyTheme(config);
    greet();
    current = null;
    setBusy(false);
    for (const h of history) apply(h.type, h.data, false);
    renderStatus(status);
    renderTasks(tasks || []);
  });
  es.addEventListener("tasks", (e) => renderTasks(JSON.parse(e.data)));
  es.addEventListener("config", (e) => applyTheme(JSON.parse(e.data)));
  for (const t of ["user", "delta", "tool", "note", "done", "failure", "reminder"]) {
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

// ---------- task board ----------
const SOURCE_LABEL = { me: "✏️ you", gmail: "✉️ Gmail", github: "🐙 GitHub", youtube: "▶️ YouTube", calendar: "📅 Calendar", other: "📎" };

function noteEl(t) {
  const li = document.createElement("li");
  li.className = "note";
  li.dataset.source = t.source;

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = t.done;
  box.title = t.done ? "Mark not done" : "Mark done";
  box.addEventListener("change", () => api("PATCH", `/api/tasks/${t.id}`, { done: box.checked }).catch(showErr));

  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;
  body.appendChild(title);
  if (t.notes) {
    const n = document.createElement("div");
    n.className = "notes-line";
    n.textContent = t.notes;
    body.appendChild(n);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const src = document.createElement("span");
  src.textContent = SOURCE_LABEL[t.source] || t.source;
  meta.appendChild(src);
  if (t.due) {
    const d = document.createElement("span");
    d.textContent = `due ${fmt(t.due)}`;
    if (!t.done && new Date(t.due) < new Date()) d.className = "overdue";
    meta.appendChild(d);
  }
  if (t.link && /^https?:\/\//.test(t.link)) {
    const a = document.createElement("a");
    a.href = t.link;
    a.target = "_blank"; // the app opens these in your real browser
    a.rel = "noopener noreferrer";
    a.textContent = "open ↗";
    meta.appendChild(a);
  }
  body.appendChild(meta);

  const x = document.createElement("button");
  x.className = "x";
  x.textContent = "✕";
  x.title = "Remove";
  x.addEventListener("click", () => api("DELETE", `/api/tasks/${t.id}`).catch(showErr));

  li.append(box, body, x);
  return li;
}

function renderTasks(list) {
  const open = list.filter((t) => !t.done).sort((a, b) =>
    (a.due || "9999").localeCompare(b.due || "9999") || b.createdAt.localeCompare(a.createdAt));
  const done = list.filter((t) => t.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  $("taskList").replaceChildren(...open.map(noteEl));
  $("doneList").replaceChildren(...done.map(noteEl));
  $("taskEmpty").hidden = open.length > 0;
  $("doneBox").hidden = done.length === 0;
  $("doneCount").textContent = String(done.length);
  $("taskCount").textContent = String(open.length);
  $("taskCount").hidden = open.length === 0;
}

$("taskForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("taskInput");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  api("POST", "/api/tasks", { title }).catch(showErr);
});

$("syncBtn").addEventListener("click", async () => {
  $("syncBtn").disabled = true;
  try { await api("POST", "/api/sync"); }
  catch (e) { showErr(e); $("syncBtn").disabled = busy; }
});

// ---------- reminders ----------
const fmt =(iso) => new Date(iso).toLocaleString(undefined, {
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
