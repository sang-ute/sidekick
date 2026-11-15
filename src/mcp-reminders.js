// Stdio MCP server that gives Claude Code reminder tools.
// Claude Code launches this itself (via --mcp-config); SIDEKICK_DATA points at the data folder.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const reminders = require("./reminders");

const DATA = process.env.SIDEKICK_DATA;
if (!DATA) {
  console.error("SIDEKICK_DATA is not set");
  process.exit(1);
}

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const server = new McpServer({ name: "sidekick", version: "0.2.0" });

server.registerTool(
  "create_reminder",
  {
    description:
      "Schedule a desktop notification for the user. due_at is an ISO 8601 datetime WITH the user's UTC offset, e.g. 2026-11-16T17:30:00+07:00.",
    inputSchema: {
      text: z.string().min(1).describe("Notification text, phrased as the reminder itself"),
      due_at: z.string().describe("ISO 8601 datetime with offset"),
      repeat: z.enum(["none", "daily", "weekly"]).optional(),
    },
  },
  async ({ text, due_at, repeat }) => {
    if (Number.isNaN(Date.parse(due_at))) return { ...json({ error: "due_at is not a valid datetime" }), isError: true };
    return json({ ok: true, reminder: reminders.add(DATA, { text, dueAt: due_at, repeat }) });
  },
);

server.registerTool(
  "list_reminders",
  { description: "List the user's upcoming reminders with their ids." },
  async () => json({ reminders: reminders.load(DATA) }),
);

server.registerTool(
  "delete_reminder",
  { description: "Delete a reminder by id (ids come from list_reminders).", inputSchema: { id: z.string() } },
  async ({ id }) => json({ deleted: reminders.remove(DATA, id) }),
);

server.connect(new StdioServerTransport());
