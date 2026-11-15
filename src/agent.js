// The brain: a streaming Claude tool-use loop.
// Conversation history is append-only (never edited) so prompt caching and
// thinking-block replay keep working across turns.
const Anthropic = require("@anthropic-ai/sdk").default;
const { z } = require("zod");
const store = require("./store");

const MODEL = "claude-opus-5-5";

const SYSTEM = `You are Sidekick, a small personal assistant living in a floating bubble on the user's Windows desktop.
Be warm, brief and practical: answers fit in a small chat panel, so prefer a few short lines over long essays.
You can set, list and delete reminders. Reminders fire as desktop notifications at the exact time, even if the panel is closed.
When the user asks to be reminded, resolve relative times ("in 20 minutes", "Friday morning") against the current local time given in their message, then call create_reminder. Confirm the exact date and time back to them.
You can search the web when a question needs fresh information.
Every user message starts with a [now: ...] tag added by the app, not typed by the user. Never mention the tag.`;

// ---------- tools ----------
const CreateReminder = z.object({
  text: z.string().min(1),
  due_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 datetime"),
  repeat: z.enum(["none", "daily", "weekly"]).optional(),
});
const DeleteReminder = z.object({ id: z.string().min(1) });

const tools = [
  {
    name: "create_reminder",
    description:
      "Schedule a desktop notification. due_at is an ISO 8601 datetime including the user's UTC offset, e.g. 2026-11-15T17:30:00+07:00.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about, phrased as the notification text." },
        due_at: { type: "string", description: "ISO 8601 datetime with offset." },
        repeat: { type: "string", enum: ["none", "daily", "weekly"] },
      },
      required: ["text", "due_at"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "List all upcoming reminders with their ids.",
    eager_input_streaming: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_reminder",
    description: "Delete a reminder by id (get ids from list_reminders).",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
];

function runTool(name, input) {
  switch (name) {
    case "create_reminder": {
      const p = CreateReminder.safeParse(input);
      if (!p.success) return { error: p.error.message };
      const r = store.addReminder({ text: p.data.text, dueAt: p.data.due_at, repeat: p.data.repeat });
      return { ok: true, reminder: r };
    }
    case "list_reminders":
      return { reminders: store.getReminders() };
    case "delete_reminder": {
      const p = DeleteReminder.safeParse(input);
      if (!p.success) return { error: p.error.message };
      return { deleted: store.removeReminder(p.data.id) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function nowTag() {
  const d = new Date();
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offMin) % 60).padStart(2, "0");
  const local = d.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  return `[now: ${local}, UTC${sign}${hh}:${mm}, tz ${Intl.DateTimeFormat().resolvedOptions().timeZone}]`;
}

// ---------- conversation ----------
class Agent {
  constructor() {
    this.messages = [];
    this.busy = false;
  }

  reset() {
    this.messages = [];
  }

  /**
   * Send one user message and run the tool loop until Claude is done.
   * ui: { delta(text), tool(name), done(), error(msg) }
   */
  async send(text, ui) {
    const apiKey = store.getApiKey();
    if (!apiKey) return ui.error("No API key yet. Paste one in settings.");
    if (this.busy) return ui.error("Still thinking about the last message…");
    this.busy = true;
    const client = new Anthropic({ apiKey });
    const start = this.messages.length;
    // Any failed exchange is removed whole (trailing truncation keeps the earlier
    // history byte-identical, so caching and thinking replay still work).
    const rollback = () => (this.messages.length = start);
    this.messages.push({ role: "user", content: `${nowTag()}\n${text}` });

    try {
      let jsonRetries = 0;
      for (let turn = 0; turn < 10; turn++) {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default", // if Opus declines, the API retries on a fallback model in the same call
          output_config: { effort: "low" }, // chat speed; raise to "medium" for harder questions
          cache_control: { type: "ephemeral" },
          system: SYSTEM,
          tools,
          messages: this.messages,
        });
        stream.on("text", (d) => ui.delta(d));

        let msg;
        try {
          msg = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          continue; // unparseable streamed tool input: re-issue the turn
        }

        if (msg.stop_reason === "refusal") {
          rollback();
          return ui.error("Claude declined that one. Try rephrasing.");
        }
        if (msg.stop_reason === "max_tokens") {
          rollback(); // a cut-off tool call would make the history invalid
          return ui.error("Reply got cut off (too long).");
        }
        this.messages.push({ role: "assistant", content: msg.content });

        if (msg.stop_reason === "pause_turn") continue; // long web search, keep going

        const calls = msg.content.filter((b) => b.type === "tool_use");
        if (msg.stop_reason !== "tool_use" || calls.length === 0) return ui.done();

        const results = calls.map((c) => {
          ui.tool(c.name);
          const out = runTool(c.name, c.input);
          return {
            type: "tool_result",
            tool_use_id: c.id,
            is_error: Boolean(out.error),
            content: JSON.stringify(out),
          };
        });
        this.messages.push({ role: "user", content: results }); // all results in one message
        ui.delta("\n");
      }
      rollback();
      ui.error("Stopped after too many steps.");
    } catch (err) {
      rollback();
      if (err instanceof Anthropic.AuthenticationError) ui.error("API key was rejected. Check it in settings.");
      else if (err instanceof Anthropic.RateLimitError) ui.error("Rate limited. Wait a moment and try again.");
      else if (err instanceof Anthropic.APIConnectionError) ui.error("Can't reach Claude. Are you online?");
      else if (err instanceof Anthropic.APIError) ui.error(`API error ${err.status}: ${err.message}`);
      else ui.error(String(err && err.message ? err.message : err));
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Agent };
