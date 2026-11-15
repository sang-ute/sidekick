// Bridge to the locally installed Claude Code CLI, using the user's own Claude login
// (Pro/Max subscription). One long-lived `claude -p` process per conversation, talking
// newline-delimited JSON over stdin/stdout. If it dies, the next message resumes the
// same session with --resume, so context survives.
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STYLE = {
  brief: "Keep replies to one to three short lines unless the user asks for more.",
  balanced: "Be brief by default: a few short lines, with more detail only when it helps.",
  detailed: "Give complete answers: explain your reasoning and list steps when useful, still using simple formatting.",
};

/** The system prompt, built from what the user has switched on in settings. */
function buildSystemPrompt(cfg) {
  const on = cfg.integrations || {};
  const tools = [
    "- Reminders: create_reminder / list_reminders / delete_reminder. They fire as desktop notifications at the exact time. Resolve relative times (\"in 20 minutes\", \"Friday morning\") against the [now: ...] tag and confirm the exact date and time.",
    "- Task board: add_task / list_tasks / complete_task / delete_task. The board is pinned in the app. Use it for things the user needs to act on.",
  ];
  if (on.github) tools.push("- GitHub: github_inbox (read-only, via the user's gh login).");
  if (on.youtube) tools.push("- YouTube: youtube_latest, youtube_follow.");
  const google = [on.gmail && "Gmail", on.calendar && "Google Calendar"].filter(Boolean);
  if (google.length) {
    tools.push(`- ${google.join(" / ")}: claude.ai connectors, when the user has connected them. If a connector's tools aren't available, say it needs connecting at claude.ai → Settings → Connectors (or in Sidekick settings → Connections).`);
  }
  if (on.web) tools.push("- Web search and page reading for fresh information.");
  const custom = Object.keys(cfg.mcpServers || {});
  if (custom.length) tools.push(`- The user's own MCP servers: ${custom.join(", ")}.`);

  const sync = ["1. list_tasks first so you don't add duplicates."];
  if (on.github) sync.push("- github_inbox: add a task for each PR waiting for their review and each assigned issue (source github, with link). Notifications can be stale (a failed CI run may already be fixed by a later run), so mention them as \"worth a look\", not as emergencies.");
  if (on.gmail) sync.push("- Gmail (if connected): search recent unread mail in the inbox; add a task only for mail that needs a reply or action (source gmail, with link if you have one). Skip newsletters, promotions and notifications.");
  if (on.calendar) sync.push("- Google Calendar (if connected): note today's and tomorrow's events; add a task only when something needs preparing (source calendar).");
  if (on.youtube) sync.push("- youtube_latest: add one task per new video worth watching (source youtube, with link).");
  sync.push("- Finish with a 2-4 line summary: what's new and the most important thing to do first.");

  return [
    "You are Sidekick, a small personal assistant who lives on the user's Windows desktop as a little blue mascot, running on Claude Code.",
    `Replies show in a small chat panel, so use simple formatting. ${STYLE[cfg.responseStyle] || STYLE.balanced}`,
    cfg.language ? `Always reply in ${cfg.language}.` : "Reply in the language the user writes in.",
    "",
    "Your tools:",
    ...tools,
    "",
    "When asked to sync or check what's new:",
    ...sync,
    "",
    "Never send, delete, archive or modify emails, issues or anything else on the user's behalf unless they ask in this chat. Drafts are fine when asked.",
    "Every user message starts with a [now: ...] tag added by the app, not typed by the user. Never mention the tag.",
  ].join("\n");
}

/** Environment for child processes, without markers that would confuse them. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE; // don't look like a nested session if launched from a Claude Code terminal
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function findClaude() {
  if (process.env.SIDEKICK_CLAUDE_PATH) return process.env.SIDEKICK_CLAUDE_PATH;
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf8", windowsHide: true });
    const hit = out.split(/\r?\n/).find((l) => /\.(exe|cmd)$/i.test(l.trim()));
    if (hit) return hit.trim();
  } catch {}
  const fallback = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return fs.existsSync(fallback) ? fallback : null;
}

function nowTag() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = d.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  return `[now: ${local}, UTC${off >= 0 ? "+" : "-"}${hh}:${mm}]`;
}

/**
 * Events: status({state, model?, connectors?}), delta(text), tool(name),
 *         done(), error(message), note(message)
 */
class ClaudeSession extends EventEmitter {
  constructor({ dataDir, config }) {
    super();
    this.dataDir = dataDir;
    this.config = config;
    this.workDir = path.join(dataDir, "workspace"); // empty folder: no project files or CLAUDE.md
    this.mcpFile = path.join(dataDir, "mcp.json");
    this.claudePath = findClaude();
    this.proc = null;
    this.sessionId = null; // set by Claude Code's init message; used to resume after a crash
    this.busy = false;
    this.buf = "";
  }

  get ready() {
    return Boolean(this.claudePath);
  }

  writeMcpConfig() {
    const on = this.config.integrations || {};
    const disabled = ["github", "youtube"].filter((k) => !on[k]);
    const servers = {
      sidekick: {
        command: process.execPath, // node, or Sidekick.exe acting as node
        args: [path.join(__dirname, "mcp-sidekick.js")],
        env: { ELECTRON_RUN_AS_NODE: "1", SIDEKICK_DATA: this.dataDir, SIDEKICK_DISABLED: disabled.join(",") },
      },
    };
    // The user's own servers from settings.
    for (const [name, s] of Object.entries(this.config.mcpServers || {})) {
      servers[name] = s.type === "http"
        ? { type: "http", url: s.url, headers: s.headers || {} }
        : { type: "stdio", command: s.command, args: s.args || [], env: s.env || {} };
    }
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(this.mcpFile, JSON.stringify({ mcpServers: servers }, null, 2));
  }

  start() {
    if (this.proc) return;
    if (!this.claudePath) throw new Error("Claude Code isn't installed (couldn't find `claude`).");
    this.writeMcpConfig();
    const on = this.config.integrations || {};
    // claude.ai connectors only work once connected on claude.ai. The system prompt
    // forbids sending/deleting anything unless the user asks in the chat.
    const connectors = { gmail: "mcp__claude_ai_Gmail", calendar: "mcp__claude_ai_Google_Calendar" };
    const allowed = [
      "mcp__sidekick",
      ...(on.web ? ["WebSearch", "WebFetch"] : []),
      ...Object.entries(connectors).filter(([k]) => on[k]).map(([, t]) => t),
      ...(this.config.extraAllowedTools || []),
    ];
    const blocked = Object.entries(connectors).filter(([k]) => !on[k]).map(([, t]) => t);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt", buildSystemPrompt(this.config),
      "--mcp-config", this.mcpFile,
      "--tools", on.web ? "WebSearch,WebFetch" : "", // never shell or file editing from the mascot
      "--allowedTools", allowed.join(","),
      "--effort", this.config.effort || "low",
    ];
    if (blocked.length) args.push("--disallowedTools", blocked.join(","));
    if (this.config.model) args.push("--model", this.config.model);
    if (this.sessionId) args.push("--resume", this.sessionId);

    this.emit("status", { state: "starting" });
    const proc = spawn(this.claudePath, args, { cwd: this.workDir, env: cleanEnv(), windowsHide: true });
    this.proc = proc;
    this.buf = "";
    let stderr = "";

    // Claude Code only reports its model once a message arrives; show "ready" as soon as it's up.
    proc.on("spawn", () => this.emit("status", { state: "ready" }));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.handle(JSON.parse(line));
        } catch {
          /* ignore non-JSON lines */
        }
      }
    });
    proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on("error", (err) => this.fail(`Couldn't start Claude Code: ${err.message}`));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return; // an old process we already replaced
      this.proc = null;
      this.emit("status", { state: "stopped" });
      if (this.busy) {
        const hint = /resume|session/i.test(stderr) ? " (old session couldn't be resumed, starting fresh)" : "";
        if (hint) this.sessionId = null;
        this.fail(`Claude Code stopped (exit ${code})${hint}. ${stderr.trim().split("\n").pop() || ""}`.trim());
      }
    });
  }

  handle(m) {
    if (m.type === "system" && m.subtype === "init") {
      this.sessionId = m.session_id;
      const connectors = (m.mcp_servers || []).map((s) => ({ name: s.name, status: s.status }));
      this.emit("status", { state: "ready", model: m.model, connectors });
      return;
    }
    if (m.type === "stream_event" && !m.parent_tool_use_id) {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") this.emit("delta", e.delta.text);
      if (e.type === "content_block_start" && /tool_use$/.test(e.content_block?.type || "")) {
        this.emit("tool", e.content_block.name);
      }
      return;
    }
    if (m.type === "result") {
      this.busy = false;
      const denied = (m.permission_denials || []).map((d) => d.tool_name);
      if (denied.length) {
        this.emit("note", `Not allowed to use: ${[...new Set(denied)].join(", ")}. You can allow it in Settings → Connections → Auto-approved tools.`);
      }
      if (m.is_error) this.emit("error", typeof m.result === "string" ? m.result : `Claude Code error (${m.subtype})`);
      else this.emit("done");
    }
  }

  fail(msg) {
    this.busy = false;
    this.emit("error", msg);
  }

  send(text) {
    if (this.busy) return this.emit("error", "Still working on the last message…");
    try {
      this.start();
    } catch (err) {
      return this.emit("error", err.message);
    }
    this.busy = true;
    const msg = { type: "user", message: { role: "user", content: `${nowTag()}\n${text}` } };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.busy = false;
    if (!p) return;
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch {} }, 1500);
  }

  reset() {
    this.stop();
    this.sessionId = null;
  }

  /** Apply new settings: restart Claude Code, keeping the conversation (--resume). */
  restart(config) {
    if (config) this.config = config;
    const wasBusy = this.busy;
    this.stop();
    if (wasBusy) this.emit("error", "Restarted Claude Code with your new settings. Please send that again.");
    if (this.ready) { try { this.start(); } catch {} }
  }
}

module.exports = { ClaudeSession, findClaude, cleanEnv };
