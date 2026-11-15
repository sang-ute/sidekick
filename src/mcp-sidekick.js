// Stdio MCP server with Sidekick's tools. Claude Code launches it (via --mcp-config);
// SIDEKICK_DATA points at the data folder shared with the app.
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const reminders = require("./reminders");
const tasks = require("./tasks");
const { githubInbox, youtubeLatest, resolveChannel } = require("./integrations");

const DATA = process.env.SIDEKICK_DATA;
if (!DATA) {
  console.error("SIDEKICK_DATA is not set");
  process.exit(1);
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });
const configFile = path.join(DATA, "config.json");
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, "utf8")); } catch { return {}; } };
const writeConfig = (patch) => fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), ...patch }, null, 2));

const server = new McpServer({ name: "sidekick", version: "0.4.0" });

// ---------- reminders ----------
server.registerTool(
  "create_reminder",
  {
    description:
      "Schedule a desktop notification. due_at is an ISO 8601 datetime WITH the user's UTC offset, e.g. 2026-11-16T17:30:00+07:00.",
    inputSchema: {
      text: z.string().min(1).describe("Notification text, phrased as the reminder itself"),
      due_at: z.string().describe("ISO 8601 datetime with offset"),
      repeat: z.enum(["none", "daily", "weekly"]).optional(),
    },
  },
  async ({ text, due_at, repeat }) => {
    if (Number.isNaN(Date.parse(due_at))) return fail("due_at is not a valid datetime");
    return ok({ reminder: reminders.add(DATA, { text, dueAt: due_at, repeat }) });
  },
);
server.registerTool("list_reminders", { description: "List upcoming reminders with their ids." },
  async () => ok({ reminders: reminders.load(DATA) }));
server.registerTool(
  "delete_reminder",
  { description: "Delete a reminder by id.", inputSchema: { id: z.string() } },
  async ({ id }) => ok({ deleted: reminders.remove(DATA, id) }),
);

// ---------- task board ----------
server.registerTool(
  "add_task",
  {
    description:
      "Pin a to-do on the user's task board. Use for anything they need to act on. Always pass the link when the task comes from an email, PR, issue or video; tasks with the same link are not added twice.",
    inputSchema: {
      title: z.string().min(1).describe("Short, action-first, e.g. 'Review PR #12 in portfolio'"),
      source: z.enum(tasks.SOURCES).optional().describe("Where it came from"),
      link: z.string().optional().describe("URL to open the item"),
      notes: z.string().optional().describe("One line of context"),
      due: z.string().optional().describe("ISO 8601 datetime if there is a deadline"),
    },
  },
  async (input) => ok(tasks.add(DATA, input)),
);
server.registerTool(
  "list_tasks",
  { description: "List the task board. Check it before adding tasks to avoid duplicates.",
    inputSchema: { include_done: z.boolean().optional() } },
  async ({ include_done }) => ok({ tasks: tasks.load(DATA).filter((t) => include_done || !t.done) }),
);
server.registerTool(
  "complete_task",
  { description: "Mark a task done (or not done with done=false).", inputSchema: { id: z.string(), done: z.boolean().optional() } },
  async ({ id, done = true }) => { const t = tasks.update(DATA, id, { done }); return t ? ok({ task: t }) : fail("no such task"); },
);
server.registerTool(
  "delete_task",
  { description: "Remove a task from the board.", inputSchema: { id: z.string() } },
  async ({ id }) => ok({ deleted: tasks.remove(DATA, id) }),
);

// ---------- GitHub (read-only, user's gh login) ----------
server.registerTool(
  "github_inbox",
  { description: "The user's GitHub to-dos: PRs waiting for their review, issues assigned to them, their open PRs, unread notifications. Read-only." },
  async () => { const r = await githubInbox(); return r.error ? fail(r.error) : ok(r); },
);

// ---------- YouTube (public RSS) ----------
server.registerTool(
  "youtube_latest",
  { description: "New videos from the channels the user follows in Sidekick.",
    inputSchema: { since_days: z.number().min(1).max(30).optional() } },
  async ({ since_days }) => {
    try { return ok(await youtubeLatest(DATA, readConfig().youtubeChannels || [], since_days || 2)); }
    catch (e) { return fail(e.message); }
  },
);
server.registerTool(
  "youtube_follow",
  { description: "Follow (or unfollow) a YouTube channel by @handle, channel URL or channel id.",
    inputSchema: { channel: z.string(), unfollow: z.boolean().optional() } },
  async ({ channel, unfollow }) => {
    const list = readConfig().youtubeChannels || [];
    const key = channel.trim();
    if (unfollow) {
      writeConfig({ youtubeChannels: list.filter((c) => c.toLowerCase() !== key.toLowerCase()) });
      return ok({ following: readConfig().youtubeChannels });
    }
    try { await resolveChannel(DATA, key); } catch (e) { return fail(e.message); }
    if (!list.some((c) => c.toLowerCase() === key.toLowerCase())) list.push(key);
    writeConfig({ youtubeChannels: list });
    return ok({ following: list });
  },
);

server.connect(new StdioServerTransport());
