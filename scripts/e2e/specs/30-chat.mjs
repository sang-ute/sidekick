// Chatting through the real composer: streaming, tools, errors, crashes, new chat.
import { boardTitles, chat, openPanel, TASKS_TAB } from "../lib/app.mjs";

export default (test) => {
  test("a message gets a streamed, formatted reply", async (ctx) => {
    const { assert } = ctx;
    const msgs = await chat(ctx, "hello from the e2e test");
    assert.equal(msgs[0].kind, "user");
    assert.equal(msgs[0].text, "hello from the e2e test");
    const reply = msgs.at(-1);
    assert.equal(reply.kind, "bot md");
    if (ctx.fake) {
      assert.equal(reply.text, "Echo: hello from the e2e test");
      assert.match(reply.html, /<strong>Echo:<\/strong>/);
    }
  });

  test(
    "Claude's tool call pins a task, on the board and in the notifier",
    async (ctx) => {
      const { assert, waitFor } = ctx;
      const title = `Buy oat milk (${ctx.runId})`;
      const msgs = await chat(ctx, `add task: ${title}`);
      assert.ok(msgs.some((m) => m.kind === "note" && m.text === "📌 pinning a task…"), JSON.stringify(msgs));
      assert.match(msgs.at(-1).text, /^Pinned/);
      const p = await openPanel(ctx);
      await p.click(TASKS_TAB);
      await waitFor(async () => (await boardTitles(p)).includes(title), { what: "Claude's task on the board" });
      const m = await ctx.win("mascot");
      await waitFor(async () => (await m.texts("#notifier .n-title")).includes(`New task: ${title}`), {
        what: "the new-task notification",
      });
    },
    { fakeOnly: true },
  );

  test(
    "an error from Claude Code is shown in the chat",
    async (ctx) => {
      const msgs = await chat(ctx, "fail please");
      ctx.assert.equal(msgs.at(-1).kind, "error");
      ctx.assert.equal(msgs.at(-1).text, "The fake model had a problem.");
    },
    { fakeOnly: true },
  );

  test(
    "a Claude Code crash is reported, and the next message works",
    async (ctx) => {
      const crash = await chat(ctx, "crash please");
      ctx.assert.equal(crash.at(-1).kind, "error");
      ctx.assert.match(crash.at(-1).text, /Claude Code stopped \(exit 3\)/);
      const next = await chat(ctx, "still there?");
      ctx.assert.equal(next.at(-1).text, "Echo: still there?");
    },
    { fakeOnly: true },
  );

  test("New chat starts over with the greeting", async (ctx) => {
    const p = await openPanel(ctx);
    await p.click('.actions button[title="New chat"]');
    await ctx.waitFor(async () => (await p.eval(`document.querySelectorAll(".log .msg").length`)) === 1, {
      what: "the chat log to reset",
    });
    ctx.assert.match(await p.text(".log .msg"), /^Hi! I'm your sidekick/);
  });
};
