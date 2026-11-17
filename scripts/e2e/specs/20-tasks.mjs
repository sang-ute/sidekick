// The task board in the chat window, and the mascot's sticky-note count.
import { boardTitles, openPanel, TASKS_TAB } from "../lib/app.mjs";

const noteWith = (title) =>
  `[...document.querySelectorAll(".notes .note")].find((n) => n.querySelector(".title").textContent === ${JSON.stringify(title)})`;

export default (test) => {
  test("add, tick off and remove a task", async (ctx) => {
    const { assert, waitFor } = ctx;
    const p = await openPanel(ctx);
    await p.click(TASKS_TAB);
    const title = `Water the plants (${ctx.runId})`;
    await p.type(".task-add input", title);
    await p.eval(`document.querySelector(".task-add").requestSubmit(), true`);
    await waitFor(async () => (await boardTitles(p)).includes(title), { what: "the task on the board" });
    assert.ok(ctx.readData("tasks.json").some((t) => t.title === title && t.source === "me"), "saved in tasks.json");

    const m = await ctx.win("mascot");
    await waitFor(async () => (await m.visible(".tasks-badge")) && (await m.text(".tasks-badge")) === "1", {
      what: "the mascot's sticky note to say 1",
    });

    await p.eval(`${noteWith(title)}.querySelector("input[type=checkbox]").click(), true`);
    await waitFor(async () => (await p.text(".done-box summary")) === "Done (1)", { what: "the task under Done" });
    await waitFor(async () => !(await m.visible(".tasks-badge")), { what: "the sticky note to hide" });
    assert.equal(ctx.readData("tasks.json")[0].done, true);

    await p.eval(`${noteWith(title)}.querySelector("button.x").click(), true`);
    await waitFor(() => ctx.readData("tasks.json").length === 0, { what: "the task to be removed" });
  });
};
