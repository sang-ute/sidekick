import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { hello, reminder, task } from "../test/fixtures";
import { fakeCore } from "../test/tauri";
import type { Hello } from "../lib/types";
import { Panel } from "./Panel";

async function open(h: Partial<Hello> = {}, handlers: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({ hello: () => hello(h), ...handlers });
  const view = render(<Panel />);
  await screen.findByText(/^Claude Code/);
  return { core, view, user: userEvent.setup() };
}
const titles = (list: HTMLElement) => within(list).queryAllByText((_, el) => el?.className === "title").map((e) => e.textContent);

describe("Panel: header", () => {
  it("shows the model and connected services", async () => {
    await open({
      status: {
        state: "ready",
        model: "claude-opus-5-5",
        connectors: [
          { name: "sidekick", status: "connected" },
          { name: "claude.ai Gmail", status: "connected" },
          { name: "claude.ai Google Calendar", status: "needs-auth" },
        ],
      },
    });
    expect(screen.getByText("Claude Code · opus-5-5 · Gmail")).toBeTruthy();
  });

  it("explains when Claude Code is missing", async () => {
    await open({ status: { state: "missing", model: null, connectors: [] } });
    const heading = screen.getByText("Claude Code not found", { selector: "h2" });
    await waitFor(() => expect(heading.closest(".view")?.hasAttribute("hidden")).toBe(false));
    expect(document.querySelector(".view.board")?.hasAttribute("hidden")).toBe(true);
  });

  it("closes on Esc and opens settings from the gear", async () => {
    const { core, user } = await open();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(core.calls.map((c) => c.cmd)).toEqual(expect.arrayContaining(["close_panel", "open_settings"]));
  });
});

describe("Panel: task board", () => {
  const board = () => document.querySelector<HTMLElement>(".notes:not(.done)")!;

  it("lists open tasks (due first) and folds done ones away", async () => {
    await open({
      tasks: [
        task({ id: "a", title: "No due date", createdAt: "2026-11-16T09:00:00.000Z" }),
        task({ id: "b", title: "Due soon", due: "2999-01-01T09:00:00.000Z" }),
        task({ id: "c", title: "Finished", done: true, doneAt: "2026-11-16T10:00:00.000Z" }),
      ],
    });
    expect(titles(board())).toEqual(["Due soon", "No due date"]);
    expect(screen.getByText("Done (1)")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Tasks/ }).textContent).toContain("2");
  });

  it("adds, ticks off and removes tasks through the core", async () => {
    const { core, user } = await open({ tasks: [task({ id: "a", title: "Email professor" })] }, {
      task_add: (a) => ({ task: task({ id: "n", title: String(a.title) }), duplicate: false }),
    });
    const input = screen.getByPlaceholderText("Add a task…");
    await user.type(input, "   {Enter}");
    await user.type(input, "Buy oat milk{Enter}");
    expect(core.called("task_add").map((c) => c.args)).toEqual([{ title: "Buy oat milk" }]);
    expect((input as HTMLInputElement).value).toBe("");

    await user.click(screen.getByTitle("Mark done"));
    expect(core.called("task_update")[0].args).toEqual({ id: "a", done: true });
    await user.click(screen.getByTitle("Remove"));
    expect(core.called("task_delete")[0].args).toEqual({ id: "a" });
  });

  it("updates live and only links to web pages", async () => {
    const { core } = await open();
    await core.send("tasks", [
      task({ id: "x", title: "Review PR", source: "github", link: "https://github.com/me/app/pull/1" }),
      task({ id: "y", title: "Odd link", link: "javascript:alert(1)" }),
    ]);
    expect(titles(board())).toEqual(["Review PR", "Odd link"]);
    const links = board().querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://github.com/me/app/pull/1");
    expect(screen.getByText("🐙 GitHub")).toBeTruthy();
  });

  it("shows sync errors in the chat log", async () => {
    const { user } = await open({}, { sync: () => Promise.reject("Busy, try again in a moment") });
    await user.click(screen.getByRole("button", { name: /Sync/ }));
    await user.click(screen.getByRole("tab", { name: /Chat/ }));
    expect(await screen.findByText("Busy, try again in a moment")).toBeTruthy();
  });
});

describe("Panel: chat", () => {
  const log = () => document.querySelector<HTMLElement>(".log")!;
  const messages = () => Array.from(log().querySelectorAll(".msg"), (m) => `${m.className.replace("msg ", "")}: ${m.textContent}`);

  it("replays the conversation so far", async () => {
    await open({ history: [{ type: "user", data: "hi" }, { type: "delta", data: "**Hello** there" }, { type: "done", data: null }] });
    expect(messages().slice(1)).toEqual(["user: hi", "bot md: Hello there"]);
    expect(log().querySelector("strong")?.textContent).toBe("Hello");
  });

  it("sends with Enter (Shift+Enter is a new line) and streams the reply", async () => {
    const { core, user } = await open();
    await user.click(screen.getByRole("tab", { name: /Chat/ }));
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>("Message Sidekick…");
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two{Enter}");
    expect(core.called("chat").map((c) => c.args)).toEqual([{ text: "line one\nline two" }]);

    await core.send("user", "line one\nline two");
    expect(box.disabled).toBe(true);
    expect(log().querySelector(".thinking")).toBeTruthy();
    await core.send("tool", "mcp__sidekick__add_task");
    await core.send("delta", "Pinned ");
    await core.send("delta", "**it**.");
    await core.send("done", null);
    expect(messages().slice(1)).toEqual([
      "user: line one\nline two",
      "note: 📌 pinning a task…",
      "bot md: Pinned it.",
    ]);
    expect(box.disabled).toBe(false);
  });

  it("shows failures and resets on a new chat", async () => {
    const { core, user } = await open();
    await user.click(screen.getByRole("tab", { name: /Chat/ }));
    await core.send("user", "hi");
    await core.send("failure", "Claude Code stopped (exit 3).");
    expect(messages().at(-1)).toBe("error: Claude Code stopped (exit 3).");
    await core.send("tool", "mcp__notion__search");
    expect(messages()).toContain("note: using notion › search…");
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(core.called("reset")).toHaveLength(1);
    await core.send("reset", null);
    expect(messages()).toHaveLength(1);
  });
});

describe("Panel: reminders", () => {
  it("lists reminders soonest first and deletes them", async () => {
    const { core, user } = await open(
      { reminders: [reminder({ id: "late", text: "Later", dueAt: "2999-02-01T09:00:00.000Z", repeat: "weekly" }), reminder({ id: "soon", text: "Sooner" })] },
      { reminders_list: () => [reminder({ id: "soon", text: "Sooner" })] },
    );
    await user.click(screen.getByRole("button", { name: "Reminders" }));
    const items = Array.from(document.querySelectorAll("#remList li"), (li) => li.firstElementChild?.firstChild?.textContent);
    expect(items).toEqual(["Sooner"]); // reloaded from the core when the view opens
    await user.click(within(document.getElementById("remList")!).getByTitle("Delete"));
    expect(core.called("reminder_delete")[0].args).toEqual({ id: "soon" });
    await waitFor(() => expect(core.called("reminders_list").length).toBeGreaterThanOrEqual(2));
  });
});
