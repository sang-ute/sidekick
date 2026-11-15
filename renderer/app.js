// Renderer: all text is inserted with textContent, never innerHTML,
// so nothing Claude or a web page says can inject HTML/scripts.
const $ = (id) => document.getElementById(id);
const api = window.sidekick;

const els = {
  bubble: $("bubble"), badge: $("badge"), panel: $("panel"),
  keyView: $("keyView"), chatView: $("chatView"), remView: $("remView"),
  log: $("log"), input: $("chatInput"), send: $("sendBtn"),
};

let current = null; // the bot bubble being streamed into
let unread = 0;
let isExpanded = false;

// ---------- view switching ----------
async function showView(name) {
  els.keyView.hidden = name !== "key";
  els.chatView.hidden = name !== "chat";
  els.remView.hidden = name !== "rem";
  if (name === "chat") els.input.focus();
  if (name === "rem") renderReminders();
  if (name === "key") $("keyInput").focus();
}

api.onExpanded(async (expanded) => {
  isExpanded = expanded;
  els.bubble.hidden = expanded;
  els.panel.hidden = !expanded;
  if (expanded) {
    unread = 0;
    els.badge.hidden = true;
    els.bubble.classList.remove("alert");
    showView((await api.hasKey()) ? "chat" : "key");
  }
});

els.bubble.addEventListener("click", () => api.toggle());
$("btnClose").addEventListener("click", () => api.collapse());
$("btnReminders").addEventListener("click", () => showView(els.remView.hidden ? "rem" : "chat"));
$("remBack").addEventListener("click", () => showView("chat"));
$("btnNew").addEventListener("click", async () => {
  await api.reset();
  els.log.replaceChildren();
  addMsg("bot", "Fresh start. What's up?");
  showView("chat");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") api.collapse(); });

// ---------- API key ----------
$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("keyErr");
  try {
    await api.setKey($("keyInput").value);
    $("keyInput").value = "";
    err.hidden = true;
    showView("chat");
  } catch (ex) {
    err.textContent = String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    err.hidden = false;
  }
});

// ---------- chat ----------
function addMsg(kind, text = "") {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}

function setBusy(busy) {
  els.send.disabled = busy;
  els.input.disabled = busy;
  if (!busy) els.input.focus();
}

function finishCurrent() {
  if (current) {
    current.classList.remove("thinking");
    current.textContent = current.textContent.trim();
    if (!current.textContent) current.remove();
  }
  current = null;
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  addMsg("user", text);
  els.input.value = "";
  autosize();
  current = addMsg("bot thinking");
  setBusy(true);
  api.send(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("chatForm").requestSubmit();
  }
});
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}
els.input.addEventListener("input", autosize);

api.onDelta((t) => {
  if (!current) current = addMsg("bot thinking");
  current.classList.remove("thinking");
  current.textContent += t;
  els.log.scrollTop = els.log.scrollHeight;
});

const TOOL_LABEL = {
  create_reminder: "⏰ setting a reminder…",
  list_reminders: "📋 checking reminders…",
  delete_reminder: "🗑 removing a reminder…",
};
api.onTool((name) => {
  finishCurrent();
  addMsg("note", TOOL_LABEL[name] || `using ${name}…`);
  current = addMsg("bot thinking");
});

api.onDone(() => { finishCurrent(); setBusy(false); });
api.onError((msg) => {
  finishCurrent();
  addMsg("error", msg);
  setBusy(false);
  if (/API key/.test(msg)) showView("key");
});

// ---------- reminders ----------
function fmt(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function renderReminders() {
  const list = (await api.listReminders()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
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
    del.addEventListener("click", async () => { await api.deleteReminder(r.id); renderReminders(); });
    li.append(info, del);
    ul.appendChild(li);
  }
}

api.onReminder((r) => {
  addMsg("note", `⏰ ${r.text}`);
  if (!isExpanded) {
    unread += 1;
    els.badge.textContent = String(unread);
    els.badge.hidden = false;
    els.bubble.classList.remove("alert");
    void els.bubble.offsetWidth; // restart the pulse animation
    els.bubble.classList.add("alert");
  }
  if (!els.remView.hidden) renderReminders();
});
