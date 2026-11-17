// The mascot's notifier bubble: lists notifications, and Clear empties them everywhere.
import { chat } from "../lib/app.mjs";

export default (test) => {
  test("the notifier lists notifications and Clear empties them", async (ctx) => {
    const { assert, waitFor } = ctx;
    if ((await ctx.invoke("hello")).notifications.length === 0 && ctx.fake) {
      await chat(ctx, `add task: Something to notify about (${ctx.runId})`);
    }
    const m = await ctx.win("mascot");
    await waitFor(async () => (await m.texts("#notifier .n-title")).length > 0, { what: "notifications in the bubble" });
    await m.clickText("#notifier .n-foot .n-btn", "Clear");
    await waitFor(async () => (await ctx.invoke("hello")).notifications.length === 0, { what: "the core to clear them" });
    assert.deepEqual(await m.texts("#notifier .n-title"), []);
    assert.deepEqual(ctx.readData("notifications.json"), []);
  });
};
