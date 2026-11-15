// Bridge to the locally installed Claude Code CLI, using the user's own Claude login
// (Pro/Max subscription). One long-lived `claude -p` process per conversation, talking
// newline-delimited JSON over stdin/stdout. If it dies, the next message resumes the
// same session with --resume, so context survives.
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SYSTEM = `You are Sidekick, a small personal assistant living in a floating bubble on the user's Windows desktop, running on Claude Code.
Be warm, brief and practical: replies show in a small chat panel, so prefer a few short lines and simple formatting.
You can set, list and delete reminders with the sidekick MCP tools. They fire as desktop notifications at the exact time, even when the panel is closed.
For a reminder, resolve relative times ("in 20 minutes", "Friday morning") against the [now: ...] tag, call create_reminder, then confirm the exact date and time.
If the user has connected claude.ai connectors (Gmail, Calendar, Drive...), you may use them. Never send, delete or modify anything on their behalf without them asking in this chat.
Every user message starts with a [now: ...] tag added by the app, not typed by the user. Never mention the tag.`;

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
    const mcp = {
      mcpServers: {
        sidekick: {
          command: process.execPath, // node, or electron.exe acting as node
          args: [path.join(__dirname, "mcp-reminders.js")],
          env: { ELECTRON_RUN_AS_NODE: "1", SIDEKICK_DATA: this.dataDir },
        },
      },
    };
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(this.mcpFile, JSON.stringify(mcp, null, 2));
  }

  start() {
    if (this.proc) return;
    if (!this.claudePath) throw new Error("Claude Code isn't installed (couldn't find `claude`).");
    this.writeMcpConfig();
    const allowed = ["mcp__sidekick", "WebSearch", "WebFetch", ...(this.config.extraAllowedTools || [])];
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt", SYSTEM,
      "--mcp-config", this.mcpFile,
      "--tools", "WebSearch,WebFetch", // no shell or file editing from the bubble
      "--allowedTools", allowed.join(","),
      "--effort", this.config.effort || "low",
    ];
    if (this.config.model) args.push("--model", this.config.model);
    if (this.sessionId) args.push("--resume", this.sessionId);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE; // don't look like a nested session if launched from a Claude Code terminal
    delete env.CLAUDE_CODE_ENTRYPOINT;

    this.emit("status", { state: "starting" });
    const proc = spawn(this.claudePath, args, { cwd: this.workDir, env, windowsHide: true });
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
        this.emit("note", `Not allowed to use: ${[...new Set(denied)].join(", ")}. Add it to "extraAllowedTools" in config.json to allow it.`);
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
}

module.exports = { ClaudeSession };
