// Reminders Claude sets through Sidekick's MCP tools: listed, deleted, and fired on time.
import { chat, openPanel } from "../lib/app.mjs";

export default (test) => {
  test(
    "the Reminders view lists a reminder and deletes it",
    async (ctx) => {
      const { waitFor } = ctx;
      const text = `call the bank (${ctx.runId})`;
      await chat(ctx, `remind me in 3600s: ${text}`);
      const p = await openPanel(ctx);
      await p.click('.actions button[title="Reminders"]');
      await waitFor(async () => (await p.texts("#remList li")).some((t) => t.includes(text)), {
        what: "the reminder in the list",
      });
      await p.eval(`[...document.querySelectorAll("#remList li")].find((li) => li.textContent.includes(${JSON.stringify(text)})).querySelector("button").click(), true`);
      await waitFor(() => (ctx.readData("reminders.json") || []).length === 0, { what: "the reminder to be deleted" });
      await p.click(".view.info button.link"); // back
    },
    { fakeOnly: true },
  );

  test(
    "a reminder fires on time: notifier, mascot bell and chat note",
    async (ctx) => {
      const { assert, waitFor } = ctx;
      const text = `stretch (${ctx.runId})`;
      const msgs = await chat(ctx, `remind me in 3s: ${text}`);
      assert.ok(msgs.some((m) => m.text === "⏰ setting a reminder…"), JSON.stringify(msgs));
      // Close the chat: the bubble only pops up when the chat window isn't open beside the mascot.
      await ctx.invoke("close_panel");
      const m = await ctx.win("mascot");
      // The scheduler checks every 15 seconds.
      await waitFor(async () => (await m.texts("#notifier .n-title")).includes(text), {
        timeout: 40000,
        what: "the reminder notification",
      });
      assert.match(await m.eval(`document.getElementById("pet").className`), /\balert\b/, "the mascot rings its bell");
      assert.ok(await m.visible("#notifier"), "the notifier pops up");
      const p = await ctx.win("panel");
      assert.ok((await p.texts(".log .msg.note")).includes(`⏰ ${text}`), "noted in the chat");
      assert.equal((ctx.readData("reminders.json") || []).length, 0, "one-off reminders are removed after firing");
    },
    { fakeOnly: true },
  );
};
