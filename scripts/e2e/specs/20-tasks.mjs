// The task board in the chat window, and the mascot's sticky-note count.
// Works whatever other specs ran before it in the same shard.
import { boardTitles, openPanel, TASKS_TAB } from "../lib/app.mjs";

const noteWith = (title) =>
  `[...document.querySelectorAll(".notes .note")].find((n) => n.querySelector(".title").textContent === ${JSON.stringify(title)})`;

export default (test) => {
  test("add, tick off and remove a task", async (ctx) => {
    const { assert, waitFor } = ctx;
    const tasks = () => ctx.readData("tasks.json") || [];
    const openCount = () => tasks().filter((t) => !t.done).length;
    const m = await ctx.win("mascot");
    const badgeMatches = async () => {
      const n = openCount();
      return n === 0 ? !(await m.visible(".tasks-badge")) : (await m.visible(".tasks-badge")) && (await m.text(".tasks-badge")) === String(n);
    };

    const p = await openPanel(ctx);
    await p.click(TASKS_TAB);
    const title = `Water the plants (${ctx.runId})`;
    await p.type(".task-add input", title);
    await p.eval(`document.querySelector(".task-add").requestSubmit(), true`);
    await waitFor(async () => (await boardTitles(p)).includes(title), { what: "the task on the board" });
    assert.ok(tasks().some((t) => t.title === title && t.source === "me"), "saved in tasks.json");
    await waitFor(badgeMatches, { what: "the mascot's sticky note to show the open-task count" });

    await p.eval(`${noteWith(title)}.querySelector("input[type=checkbox]").click(), true`);
    await waitFor(async () => (await p.texts(".notes.done .note .title")).includes(title), { what: "the task under Done" });
    assert.equal(tasks().find((t) => t.title === title).done, true);
    await waitFor(badgeMatches, { what: "the sticky note to count one task fewer" });

    await p.eval(`${noteWith(title)}.querySelector("button.x").click(), true`);
    await waitFor(() => !tasks().some((t) => t.title === title), { what: "the task to be removed" });
  });
};
