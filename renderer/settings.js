// Sidekick settings dashboard. Talks to the local server over HTTP + SSE.
// Every piece of data goes into the page with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const shellApi = window.sidekickShell; // undefined in a normal browser tab

// ---------- token (from #t=... in the URL, kept for this tab only) ----------
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};
const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
if (hashToken) {
  session.set("sidekick-token", hashToken);
  history.replaceState(null, "", location.pathname); // keep it out of the address bar
}
const TOKEN = hashToken || session.get("sidekick-token") || "";

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "x-sidekick-token": TOKEN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---------- state ----------
const state = {
  config: null,
  defaults: {},
  options: null,
  info: null,         // /api/info (slow: checks MCP servers)
  infoError: null,
  liveConnectors: null, // from the SSE status event (fresher than /api/info)
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const setValue = (input, v) => { if (document.activeElement !== input) input.value = v ?? ""; };

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === "err" ? 5000 : kind === "info" ? 4000 : 1600);
}

// ---------- saving (sequential, optimistic) ----------
let queue = Promise.resolve();
function save(partial) {
  const prev = state.config ? JSON.parse(JSON.stringify(state.config)) : null;
  if (state.config) Object.assign(state.config, partial);
  renderAll();
  const run = queue.then(async () => {
    try {
      const res = await api("PATCH", "/api/settings", partial);
      if (res && res.config) state.config = res.config;
      toast("Saved ✓");
      renderAll();
      return true;
    } catch (e) {
      if (prev) state.config = prev;
      toast(e.message, "err");
      renderAll();
      return false;
    }
  });
  queue = run.catch(() => false);
  return run;
}

// Debounced saves for text inputs. flushPending() runs them right away (on close).
const pending = new Map();
function saveLater(key, makePartial, ms = 500) {
  clearTimeout(pending.get(key)?.timer);
  const entry = { fn: () => { pending.delete(key); const p = makePartial(); if (p) save(p); } };
  entry.timer = setTimeout(entry.fn, ms);
  pending.set(key, entry);
}
function flushPending() {
  for (const entry of [...pending.values()]) { clearTimeout(entry.timer); entry.fn(); }
}

// ---------- tabs ----------
const TABS = ["general", "ai", "connections", "mascot", "about"];
function showTab(name, focusTab = false) {
  if (!TABS.includes(name)) name = "general";
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focusTab) tab.focus();
    if (on) tab.scrollIntoView({ block: "nearest", inline: "nearest" }); // narrow layout: tabs scroll sideways
  }
  $("content").scrollTop = 0;
  session.set("sidekick-settings-tab", name);
}
document.querySelectorAll('.sidebar [role="tab"]').forEach((tab) => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(tab.dataset.tab);
    const next = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (next) { e.preventDefault(); showTab(TABS[(i + next + TABS.length) % TABS.length], true); }
    if (e.key === "Home") { e.preventDefault(); showTab(TABS[0], true); }
    if (e.key === "End") { e.preventDefault(); showTab(TABS[TABS.length - 1], true); }
  });
});

// ---------- segmented control ----------
function seg(container, items, current, onPick) {
  const hadFocus = container.contains(document.activeElement);
  container.setAttribute("role", "radiogroup");
  container.replaceChildren();
  const buttons = items.map((it) => {
    const b = el("button", "", it.label);
    b.type = "button";
    b.setAttribute("role", "radio");
    const on = it.id === current;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
    if (it.hint) b.title = it.hint;
    b.addEventListener("click", () => { if (it.id !== current) onPick(it.id); });
    container.appendChild(b);
    return b;
  });
  if (!items.some((it) => it.id === current) && buttons[0]) buttons[0].tabIndex = 0;
  container.onkeydown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const idx = Math.max(0, items.findIndex((it) => it.id === current));
    const nextItem = items[(idx + step + items.length) % items.length];
    onPick(nextItem.id);
  };
  if (hadFocus) {
    const checked = container.querySelector('[aria-checked="true"]') || buttons[0];
    checked?.focus();
  }
}

// ---------- shared helpers ----------
const findConnector = (re) => connectors().find((c) => re.test(c.name));
function connectors() {
  const byName = new Map();
  for (const c of state.info?.connectors || []) byName.set(c.name, { ...c });
  for (const c of state.liveConnectors || []) byName.set(c.name, { ...(byName.get(c.name) || {}), ...c });
  return [...byName.values()].filter((c) => c.name !== "sidekick");
}
function pill(kind, text) { return el("span", `pill ${kind}`, text); }
function statusPill(status) {
  switch (status) {
    case "connected": return pill("ok", "Connected");
    case "needs-auth": return pill("warn", "Needs sign-in");
    case "failed": return pill("err", "Failed");
    case "pending": return pill("", "Starting…");
    default: return pill("", status || "Unknown");
  }
}
function smallBtn(text, onClick, cls = "btn small") {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
function skeletonLines(container, widths = ["w60", "w80", "w40"]) {
  container.replaceChildren(...widths.map((w) => el("span", `skel ${w}`)));
}
async function post(url, body, okMsg) {
  try {
    const res = await api("POST", url, body ?? {});
    if (okMsg) toast(okMsg, "info");
    return res;
  } catch (e) {
    toast(e.message, "err");
    return null;
  }
}
const openTarget = (target) => post("/api/open", { target });

// ---------- render: General ----------
const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" };
const MOD_KEYS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const KEY_RE = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|plus|printscreen|num[0-9]|[)!@#$%^&*(:;<_>?~{|}"',./`[\]\\=-])$/i;
function validShortcut(s) {
  const parts = String(s).split("+").map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return false;
  const key = parts.pop();
  return parts.every((p) => MOD_KEYS.has(p.toLowerCase())) && KEY_RE.test(key);
}

function renderGeneral() {
  const c = state.config;
  const themes = (state.options.themes || ["system", "light", "dark"]).map((id) => ({ id, label: THEME_LABEL[id] || id }));
  seg($("segTheme"), themes, c.theme || "system", (v) => save({ theme: v }));
  $("openAtLogin").checked = Boolean(c.openAtLogin);
  setValue($("shortcut"), c.shortcut || "");
  if (document.activeElement !== $("shortcut")) {
    $("shortcut").classList.remove("invalid");
    $("shortcutErr").hidden = true;
  }
  const on = Boolean(c.dailySyncTime);
  $("syncOn").checked = on;
  $("syncTimeRow").hidden = !on;
  setValue($("syncTime"), c.dailySyncTime || state.defaults.dailySyncTime || "08:30");
}

$("openAtLogin").addEventListener("change", (e) => save({ openAtLogin: e.target.checked }));
$("shortcut").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  const ok = validShortcut(v);
  e.target.classList.toggle("invalid", !ok);
  $("shortcutErr").hidden = ok;
  if (ok) saveLater("shortcut", () => ({ shortcut: v }), 700);
  else clearTimeout(pending.get("shortcut")?.timer), pending.delete("shortcut");
});
$("shortcut").addEventListener("blur", () => { if (!pending.has("shortcut")) renderGeneral(); });
$("syncOn").addEventListener("change", (e) => {
  const time = $("syncTime").value || state.defaults.dailySyncTime || "08:30";
  save({ dailySyncTime: e.target.checked ? time : null });
});
$("syncTime").addEventListener("change", (e) => {
  if ($("syncOn").checked && /^\d{2}:\d{2}$/.test(e.target.value)) save({ dailySyncTime: e.target.value });
});

// ---------- render: AI & account ----------
function methodLabel(auth) {
  const provider = (auth.apiProvider || "").toLowerCase();
  if (provider && provider !== "firstparty") {
    return { bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry" }[provider] || auth.apiProvider;
  }
  const m = (auth.authMethod || "").toLowerCase();
  if (m.includes("claude")) return "Claude subscription (claude.ai)";
  if (m.includes("console") || m.includes("api")) return "Anthropic Console (API billing)";
  return auth.authMethod || "Unknown";
}
const titleCase = (s) => String(s || "").replace(/(^|[\s_-])(\w)/g, (_, a, b) => a + b.toUpperCase());

function renderAccount() {
  const card = $("accountCard");
  const dot = $("acctDot");
  const details = $("acctDetails");
  const info = state.info;
  const loginBtns = [$("btnLoginClaude"), $("btnLoginConsole")];

  if (!info) {
    card.setAttribute("aria-busy", "true");
    dot.className = "big-dot";
    $("acctTitle").textContent = state.infoError ? "Couldn't check Claude Code" : "Checking Claude Code…";
    $("acctSub").textContent = state.infoError || "";
    if (state.infoError) details.replaceChildren(); else skeletonLines(details);
    $("btnLogout").disabled = true;
    return;
  }
  card.removeAttribute("aria-busy");
  const claude = info.claude || {};
  const auth = claude.auth;
  details.replaceChildren();
  const addRow = (k, v) => { if (v) details.append(el("dt", "", k), el("dd", "", v)); };

  if (!claude.found) {
    dot.className = "big-dot err";
    $("acctTitle").textContent = "Claude Code not found";
    $("acctSub").textContent = "Install Claude Code, then run claude once in a terminal.";
    loginBtns.forEach((b) => (b.disabled = true));
    $("btnLogout").disabled = true;
    return;
  }
  loginBtns.forEach((b) => (b.disabled = false));
  const signedIn = Boolean(auth && auth.loggedIn);
  // When signed in, signing in again means switching accounts, so tone the buttons down.
  $("btnLoginClaude").className = signedIn ? "btn" : "btn primary";
  $("btnLoginClaude").textContent = signedIn ? "Switch Claude account" : "Sign in with Claude subscription";
  $("btnLoginConsole").textContent = signedIn ? "Use Anthropic Console (API billing)" : "Sign in with Anthropic Console (API billing)";
  if (signedIn) {
    dot.className = "big-dot ok";
    $("acctTitle").textContent = "Signed in";
    $("acctSub").textContent = methodLabel(auth);
    addRow("Plan", auth.subscriptionType ? titleCase(auth.subscriptionType) : "");
    addRow("Email", auth.email);
    addRow("Organization", auth.orgName);
    addRow("Claude Code", claude.version ? `v${String(claude.version).replace(/^v/, "")}` : "");
    $("btnLogout").disabled = false;
  } else {
    dot.className = "big-dot warn";
    $("acctTitle").textContent = "Not signed in";
    $("acctSub").textContent = "Sign in so Sidekick can use Claude.";
    $("btnLogout").disabled = true;
  }
}

function renderAI() {
  const c = state.config;
  const o = state.options;
  const models = o.models || [];
  const sel = $("model");
  const cur = c.model ?? "";
  if (document.activeElement !== sel) {
    const opts = models.map((m) => {
      const op = el("option", "", m.label);
      op.value = m.id ?? "";
      return op;
    });
    if (!models.some((m) => (m.id ?? "") === cur)) {
      const op = el("option", "", `${cur} (custom)`);
      op.value = cur;
      opts.push(op);
    }
    sel.replaceChildren(...opts);
    sel.value = cur;
  }
  $("modelNote").textContent = models.find((m) => (m.id ?? "") === cur)?.note || "";

  const efforts = o.efforts || [];
  seg($("segEffort"), efforts, c.effort, (v) => save({ effort: v }));
  $("effortHint").textContent = efforts.find((e) => e.id === c.effort)?.hint || "";
  const styles = o.responseStyles || [];
  seg($("segStyle"), styles, c.responseStyle, (v) => save({ responseStyle: v }));
  $("styleHint").textContent = styles.find((s) => s.id === c.responseStyle)?.hint || "";
  setValue($("language"), c.language || "");
}

$("model").addEventListener("change", (e) => save({ model: e.target.value || null }));
$("language").addEventListener("input", (e) => saveLater("language", () => ({ language: e.target.value.trim() })));
$("btnRestart").addEventListener("click", () => post("/api/claude/restart", {}, "Claude Code is restarting…"));
$("btnRefreshInfo").addEventListener("click", () => loadInfo(true));
$("btnLoginClaude").addEventListener("click", () => login("claudeai"));
$("btnLoginConsole").addEventListener("click", () => login("console"));
$("btnLogout").addEventListener("click", async () => {
  if (!confirm("Sign out of Claude Code?\n\nSidekick, and Claude Code in your terminals, won't work until you sign in again.")) return;
  const res = await post("/api/claude/logout", {});
  if (!res) return;
  toast("Signed out", "info");
  if (res.auth !== undefined && state.info?.claude) {
    state.info.claude.auth = res.auth;
    renderAccount();
  } else {
    loadInfo();
  }
});

let pollTimer = null;
async function login(method) {
  const res = await post("/api/claude/login", { method }, "Finish signing in in the terminal and browser window that just opened.");
  if (!res) return;
  // Watch for the sign-in to land, for up to ~2 minutes.
  const before = JSON.stringify(state.info?.claude?.auth || null);
  let tries = 0;
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    tries += 1;
    await loadInfo(false, true);
    const now = JSON.stringify(state.info?.claude?.auth || null);
    if (now !== before || tries >= 24) {
      clearInterval(pollTimer);
      if (now !== before && state.info?.claude?.auth?.loggedIn) toast("Signed in ✓");
    }
  }, 5000);
}

// ---------- render: Connections ----------
const BUILTINS = [
  { key: "github", icon: "🐙", name: "GitHub", desc: "PRs waiting for your review, assigned issues and notifications. Read-only, via the gh CLI." },
  { key: "gmail", icon: "✉️", name: "Gmail", desc: "Finds mail that needs a reply. Uses your claude.ai Gmail connector." },
  { key: "calendar", icon: "📅", name: "Google Calendar", desc: "Upcoming events. Uses your claude.ai Calendar connector." },
  { key: "youtube", icon: "▶️", name: "YouTube", desc: "New videos from channels you follow. No account needed." },
  { key: "web", icon: "🔎", name: "Web search & fetch", desc: "Lets Claude look things up online." },
];

function builtinStatus(key) {
  const side = [];
  const info = state.info;
  if (key === "github") {
    const gh = info?.github;
    if (!gh) side.push(pill("", "Checking…"));
    else if (!gh.installed) {
      side.push(pill("warn", "gh not installed"));
      const a = el("a", "link", "Get GitHub CLI ↗");
      a.href = "https://cli.github.com/";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      side.push(a);
    } else if (!gh.loggedIn) {
      side.push(pill("warn", "Signed out"));
      side.push(smallBtn("Sign in to GitHub", async () => {
        if (await post("/api/github/login", {}, "Finish signing in in the terminal that just opened, then press Refresh on the AI tab.")) {
          setTimeout(() => loadInfo(false, true), 15000);
        }
      }));
    } else side.push(pill("ok", gh.user ? `@${gh.user}` : "Signed in"));
  } else if (key === "gmail" || key === "calendar") {
    const conn = findConnector(key === "gmail" ? /gmail/i : /calendar/i);
    if (!conn && !info && !state.liveConnectors) side.push(pill("", "Checking…"));
    else if (!conn) {
      side.push(pill("", "Not connected"));
      side.push(smallBtn("Connect on claude.ai", () => openTarget("connectors")));
    } else {
      side.push(statusPill(conn.status));
      if (conn.status === "needs-auth") side.push(smallBtn("Authorize", () => mcpLogin(conn.name)));
    }
  } else if (key === "youtube") {
    const n = (state.config.youtubeChannels || []).length;
    side.push(pill(n ? "info" : "", n ? `${n} channel${n === 1 ? "" : "s"}` : "No channels yet"));
  } else if (key === "web") {
    side.push(pill("info", "Built in"));
  }
  return side;
}

function renderBuiltins() {
  const list = $("builtinList");
  const integ = state.config.integrations || {};
  list.replaceChildren(...BUILTINS.map((b) => {
    const enabled = integ[b.key] !== false;
    const row = el("div", `item${enabled ? "" : " off"}`);
    const ic = el("div", "ic", b.icon);
    ic.setAttribute("aria-hidden", "true");
    const main = el("div", "main");
    main.append(el("div", "name", b.name), el("div", "desc", b.desc));
    const side = el("div", "side");
    side.append(...builtinStatus(b.key));
    const sw = el("label", "switch");
    sw.title = enabled ? `Turn off ${b.name}` : `Turn on ${b.name}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.setAttribute("aria-label", `Use ${b.name}`);
    input.addEventListener("change", () => save({ integrations: { ...(state.config.integrations || {}), [b.key]: input.checked } }));
    sw.append(input, el("span"));
    side.append(sw);
    row.append(ic, main, side);
    return row;
  }));
}

async function mcpLogin(name) {
  await post("/api/mcp/login", { name }, `Finish authorizing ${name.replace(/^claude\.ai /, "")} in the window that just opened.`);
}

function renderConnectors() {
  const list = $("connectorList");
  const items = connectors();
  if (!state.info && !state.liveConnectors) {
    const row = el("div", "item");
    const wrap = el("div", "main");
    skeletonLines(wrap, ["w40", "w60"]);
    row.append(el("div", "ic", "⏳"), wrap, el("div", "side"));
    list.replaceChildren(row);
    return;
  }
  if (!items.length) {
    const empty = el("div", "empty-line", state.infoError ? `Couldn't load connectors: ${state.infoError}` : "No connectors yet.");
    empty.append(smallBtn("Add connectors on claude.ai", () => openTarget("connectors")));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...items.map((c) => {
    const isClaudeAi = c.source === "claudeai" || /^claude\.ai /.test(c.name);
    const row = el("div", "item");
    const ic = el("div", "ic", isClaudeAi ? "☁️" : "🧩");
    ic.setAttribute("aria-hidden", "true");
    const main = el("div", "main");
    main.append(
      el("div", "name", c.name.replace(/^claude\.ai /, "")),
      el("div", "desc", isClaudeAi ? "claude.ai connector" : (state.config.mcpServers || {})[c.name] ? "Sidekick custom server" : "Claude Code MCP server"),
    );
    const side = el("div", "side");
    side.append(statusPill(c.status));
    if (c.status === "needs-auth") side.append(smallBtn("Authorize", () => mcpLogin(c.name)));
    row.append(ic, main, side);
    return row;
  }));
}

function serverSummary(s) {
  if (s.type === "http") return s.url || "";
  return [s.command, ...(s.args || [])].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

function renderCustomServers() {
  const list = $("mcpList");
  const servers = state.config.mcpServers || {};
  const tools = state.config.extraAllowedTools || [];
  const names = Object.keys(servers);
  if (!names.length) {
    list.replaceChildren(el("div", "empty-line", "No custom servers yet."));
    return;
  }
  const live = new Map(connectors().map((c) => [c.name, c.status]));
  list.replaceChildren(...names.map((name) => {
    const s = servers[name] || {};
    const row = el("div", "item");
    const ic = el("div", "ic", s.type === "http" ? "🌐" : "🧩");
    ic.setAttribute("aria-hidden", "true");
    const main = el("div", "main");
    const title = el("div", "name", name);
    title.append(el("span", "tag", s.type === "http" ? "HTTP" : "stdio"));
    if (tools.includes(`mcp__${name}`)) title.append(el("span", "tag accent", "auto-approved"));
    main.append(title, el("div", "desc mono", serverSummary(s)));
    const side = el("div", "side");
    if (live.has(name)) side.append(statusPill(live.get(name)));
    side.append(smallBtn("Remove", () => {
      if (!confirm(`Remove the MCP server "${name}"?`)) return;
      const next = { ...servers };
      delete next[name];
      const nextTools = tools.filter((t) => t !== `mcp__${name}` && !t.startsWith(`mcp__${name}__`));
      save({ mcpServers: next, extraAllowedTools: nextTools });
    }, "btn small danger"));
    row.append(ic, main, side);
    return row;
  }));
}

// "a b 'c d'" → ["a", "b", "c d"]; backslashes are kept as-is (Windows paths).
function splitArgs(s) {
  const out = [];
  let cur = "";
  let quote = null;
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

function parseKV(text, kind) {
  const out = {};
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

function mcpType() { return document.querySelector('input[name="mcpType"]:checked')?.value || "stdio"; }
function syncMcpType() {
  const http = mcpType() === "http";
  $("stdioFields").hidden = http;
  $("httpFields").hidden = !http;
  $("mcpKVLabel").textContent = http ? "Headers" : "Environment variables";
  $("mcpKVHint").textContent = http ? "optional, Name: value, one per line" : "optional, KEY=VALUE, one per line";
  $("mcpKV").placeholder = http ? "Authorization: Bearer …" : "API_KEY=…";
}
document.querySelectorAll('input[name="mcpType"]').forEach((r) => r.addEventListener("change", syncMcpType));
syncMcpType();

function showMcpError(msg) {
  $("mcpErr").textContent = msg;
  $("mcpErr").hidden = !msg;
}

$("mcpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showMcpError("");
  const c = state.config;
  if (!c) return;
  const name = $("mcpName").value.trim();
  const servers = c.mcpServers || {};
  try {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error("Name: letters, numbers, - and _ only (up to 40).");
    if (name.toLowerCase() === "sidekick") throw new Error('"sidekick" is taken by Sidekick\'s own tools.');
    if (Object.keys(servers).some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`A server named "${name}" already exists.`);
    let server;
    if (mcpType() === "http") {
      const url = $("mcpUrl").value.trim();
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error("Enter a full URL, like https://example.com/mcp."); }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("The URL must start with http:// or https://.");
      server = { type: "http", url, headers: parseKV($("mcpKV").value, "headers") };
    } else {
      const command = $("mcpCommand").value.trim();
      if (!command) throw new Error("Enter the command that starts the server, like npx.");
      server = { type: "stdio", command, args: splitArgs($("mcpArgs").value.trim()), env: parseKV($("mcpKV").value, "env") };
    }
    const patch = { mcpServers: { ...servers, [name]: server } };
    if ($("mcpAuto").checked) {
      patch.extraAllowedTools = [...new Set([...(c.extraAllowedTools || []), `mcp__${name}`])];
    }
    const ok = await save(patch);
    if (ok) {
      $("mcpForm").reset();
      syncMcpType();
      $("addMcp").open = false;
      toast(`Added ${name}. Claude Code is restarting to load it.`, "info");
    }
  } catch (err) {
    showMcpError(err.message);
  }
});

// chip editors
function renderChips(container, items, onRemove, emptyText) {
  container.dataset.empty = emptyText;
  container.replaceChildren(...items.map((item) => {
    const chip = el("span", "chip");
    chip.append(el("span", "", item));
    const x = el("button", "", "✕");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${item}`);
    x.addEventListener("click", () => onRemove(item));
    chip.append(x);
    return chip;
  }));
}

function renderYouTube() {
  const list = state.config.youtubeChannels || [];
  renderChips($("ytChips"), list, (item) => save({ youtubeChannels: list.filter((c) => c !== item) }), "No channels yet.");
}
$("ytForm").addEventListener("submit", (e) => {
  e.preventDefault();
  let v = $("ytInput").value.trim();
  if (!v) return;
  if (/\s/.test(v)) return toast("Channel names can't contain spaces. Use the @handle.", "err");
  if (!/^https?:\/\//i.test(v) && !/^UC[\w-]{22}$/.test(v) && !v.startsWith("@")) v = `@${v}`;
  const list = state.config.youtubeChannels || [];
  if (list.some((c) => c.toLowerCase() === v.toLowerCase())) return toast("Already following that channel.", "err");
  $("ytInput").value = "";
  save({ youtubeChannels: [...list, v] });
});

function renderTools() {
  const list = state.config.extraAllowedTools || [];
  renderChips($("toolChips"), list, (item) => save({ extraAllowedTools: list.filter((t) => t !== item) }), "None.");
}
$("toolForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("toolInput").value.trim();
  if (!v) return;
  if (v.includes(",") || v.length > 120) return toast("One tool name per entry, no commas.", "err");
  const list = state.config.extraAllowedTools || [];
  if (list.includes(v)) return toast("Already on the list.", "err");
  $("toolInput").value = "";
  save({ extraAllowedTools: [...list, v] });
});

function renderConnections() {
  if (!state.config) return;
  renderBuiltins();
  renderConnectors();
  renderCustomServers();
  renderYouTube();
  renderTools();
}

// ---------- render: Mascot ----------
const SIZE_LABEL = { small: "Small", medium: "Medium", large: "Large" };
function renderMascot() {
  const c = state.config;
  $("mascotVisible").checked = c.mascotVisible !== false;
  const sizes = (state.options.mascotSizes || ["small", "medium", "large"]).map((id) => ({ id, label: SIZE_LABEL[id] || id }));
  seg($("segSize"), sizes, c.mascotSize || "medium", (v) => save({ mascotSize: v }));
  setValue($("sleepAfter"), c.sleepAfterMinutes ?? 10);
  const n = c.notifier || {};
  $("notifierAuto").checked = n.autoShow !== false;
  setValue($("notifierHide"), n.hideAfterSeconds ?? 12);
}
$("mascotVisible").addEventListener("change", (e) => save({ mascotVisible: e.target.checked }));
$("notifierAuto").addEventListener("change", (e) => save({ notifier: { ...(state.config.notifier || {}), autoShow: e.target.checked } }));

function numberField(input, min, max, makePartial) {
  const read = () => {
    const n = Math.round(Number(input.value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  input.addEventListener("input", () => {
    const n = read();
    if (n === null || input.value === "") return;
    saveLater(input.id, () => makePartial(n), 600);
  });
  input.addEventListener("blur", () => {
    const n = read();
    if (n !== null) input.value = String(n);
  });
}
numberField($("sleepAfter"), 0, 240, (n) => ({ sleepAfterMinutes: n }));
numberField($("notifierHide"), 3, 120, (n) => ({ notifier: { ...(state.config.notifier || {}), hideAfterSeconds: n } }));

document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openTarget(b.dataset.open)));

// ---------- render: About ----------
function ghText(gh) {
  if (!gh) return "Checking…";
  if (!gh.installed) return "Not installed";
  return gh.loggedIn ? `Signed in${gh.user ? ` as @${gh.user}` : ""}` : "Signed out";
}
function renderAbout() {
  const info = state.info;
  const list = $("aboutList");
  if (!info) {
    $("aboutVersion").textContent = state.infoError ? "Version unknown" : "Version …";
    if (state.infoError) list.replaceChildren(el("dt", "", "Error"), el("dd", "", state.infoError));
    else skeletonLines(list, ["w40", "w60", "w80", "w60", "w40"]);
    return;
  }
  const app = info.app || {};
  $("aboutName").textContent = app.name || "Sidekick";
  $("aboutVersion").textContent = `Version ${app.version || "unknown"}`;
  const rows = [
    ["Version", app.version],
    ["Electron", app.electron || "not running in the app"],
    ["Chrome", app.chrome || "—"],
    ["Node", app.node],
    ["Platform", [app.platform, app.arch].filter(Boolean).join(" ")],
    ["Claude Code", info.claude?.found ? (info.claude.version ? `v${String(info.claude.version).replace(/^v/, "")}` : "found") : "Not found"],
    ["Claude Code path", info.claude?.path, true],
    ["GitHub CLI", ghText(info.github)],
    ["Data folder", info.dataDir, true],
  ];
  list.replaceChildren();
  for (const [k, v, mono] of rows) {
    if (!v) continue;
    list.append(el("dt", "", k), el("dd", mono ? "mono" : "", v));
  }
}

function diagnostics() {
  const info = state.info || {};
  const app = info.app || {};
  const auth = info.claude?.auth;
  const c = state.config || {};
  const lines = [
    `Sidekick ${app.version || "?"}`,
    `Electron ${app.electron || "-"} / Chrome ${app.chrome || "-"} / Node ${app.node || "-"}`,
    `Platform: ${[app.platform, app.arch].filter(Boolean).join(" ") || "-"}`,
    `Claude Code: ${info.claude?.found ? `found ${info.claude.version || ""}`.trim() : "not found"}`,
    `Claude auth: ${auth ? (auth.loggedIn ? `signed in (${methodLabel(auth)}${auth.subscriptionType ? `, ${auth.subscriptionType}` : ""})` : "signed out") : "unknown"}`,
    `GitHub CLI: ${info.github ? (!info.github.installed ? "not installed" : info.github.loggedIn ? "signed in" : "signed out") : "unknown"}`,
    `Connectors: ${connectors().map((x) => `${x.name.replace(/^claude\.ai /, "")}=${x.status}`).join(", ") || "none"}`,
    `Model: ${c.model || "default"} / effort ${c.effort || "-"} / style ${c.responseStyle || "-"}`,
    `Integrations: ${Object.entries(c.integrations || {}).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ") || "-"}`,
    `Custom MCP servers: ${Object.keys(c.mcpServers || {}).length}`,
    `YouTube channels: ${(c.youtubeChannels || []).length}`,
    `Daily sync: ${c.dailySyncTime || "off"} / theme ${c.theme || "system"} / mascot ${c.mascotVisible === false ? "hidden" : c.mascotSize || "medium"}`,
  ];
  return lines.join("\n");
}

$("btnCopyDiag").addEventListener("click", async () => {
  const text = diagnostics();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "input";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  toast("Diagnostics copied ✓");
});

// ---------- render all ----------
function renderAll() {
  if (!state.config || !state.options) return;
  applyTheme(state.config.theme);
  renderGeneral();
  renderAI();
  renderAccount();
  renderConnections();
  renderMascot();
  renderAbout();
}

// ---------- loading ----------
let infoInFlight = null;
async function loadInfo(announce = false, quiet = false) {
  if (infoInFlight) return infoInFlight;
  if (!quiet) {
    state.info = null;
    state.infoError = null;
    renderAccount();
    renderConnections();
    renderAbout();
  }
  infoInFlight = (async () => {
    try {
      state.info = await api("GET", "/api/info");
      state.infoError = null;
      if (announce) toast("Refreshed ✓");
    } catch (e) {
      if (!quiet || !state.info) { state.info = null; state.infoError = e.message; }
    } finally {
      infoInFlight = null;
    }
    renderAccount();
    renderConnections();
    renderAbout();
  })();
  return infoInFlight;
}

function setConn(ok, text) {
  const c = $("conn");
  c.textContent = ok ? "" : text || "Reconnecting…";
  c.classList.toggle("down", !ok);
}

function connect() {
  if (!TOKEN) {
    setConn(false, "No access token. Open settings from Sidekick.");
    return;
  }
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener("hello", (e) => {
    const d = JSON.parse(e.data || "{}");
    if (d.config) state.config = d.config;
    if (d.status?.connectors) state.liveConnectors = d.status.connectors;
    setConn(true);
    renderAll();
  });
  es.addEventListener("config", (e) => {
    const cfg = JSON.parse(e.data || "null");
    if (cfg) { state.config = cfg; renderAll(); }
  });
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data || "{}");
    if (Array.isArray(s.connectors) && s.connectors.length) {
      state.liveConnectors = s.connectors;
      if (state.config) renderConnections();
    }
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

// ---------- window ----------
function closeWindow() {
  flushPending();
  shellApi?.closeSettings();
}
if (shellApi) {
  $("btnClose").addEventListener("click", closeWindow);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) closeWindow();
  });
} else {
  $("btnClose").hidden = true;
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushPending(); });

async function init() {
  showTab(session.get("sidekick-settings-tab") || "general");
  renderAccount();
  try {
    if (!TOKEN) throw new Error("No access token. Open settings from the Sidekick mascot or tray menu.");
    const s = await api("GET", "/api/settings");
    state.config = s.config;
    state.defaults = s.defaults || {};
    state.options = s.options || {};
    document.body.classList.remove("loading");
    $("loadError").hidden = true;
    renderAll();
  } catch (e) {
    $("loadError").textContent = `Couldn't load settings: ${e.message}`;
    $("loadError").hidden = false;
  }
  if (TOKEN) {
    loadInfo();
    connect();
  }
}
init();
