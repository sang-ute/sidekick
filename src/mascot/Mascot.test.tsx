import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { config, hello, notification, reminder, task } from "../test/fixtures";
import { fakeCore } from "../test/tauri";
import type { Hello } from "../lib/types";
import { Mascot } from "./Mascot";

async function open(h: Partial<Hello> = {}, handlers: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({ hello: () => hello(h), ...handlers });
  render(<Mascot />);
  await waitFor(() => expect(core.called("hello")).toHaveLength(1));
  return { core, user: userEvent.setup() };
}
const pet = () => document.getElementById("pet")!;
const card = () => document.getElementById("notifier")!;

describe("Mascot", () => {
  it("wears a sticky note with the open-task count", async () => {
    await open({ tasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c", done: true })] });
    const badge = await screen.findByTitle("Show notifications");
    await waitFor(() => expect(badge.textContent).toBe("2"));
    expect(badge.hidden).toBe(false);
  });

  it("opens the chat on click, and the menu on right-click", async () => {
    const { core } = await open();
    fireEvent.pointerDown(pet(), { button: 0, screenX: 100, screenY: 100, pointerId: 1 });
    fireEvent.pointerUp(pet(), { button: 0, screenX: 101, screenY: 100, pointerId: 1 });
    fireEvent.contextMenu(pet());
    const cmds = core.calls.map((c) => c.cmd);
    expect(cmds).toEqual(expect.arrayContaining(["pet_drag_start", "pet_drag_end", "toggle_panel", "pet_menu"]));
    expect(cmds).not.toContain("pet_drag_move");
  });

  it("drags instead of opening the chat when the pointer moves", async () => {
    const { core } = await open();
    fireEvent.pointerDown(pet(), { button: 0, screenX: 100, screenY: 100, pointerId: 1 });
    fireEvent.pointerMove(pet(), { screenX: 140, screenY: 90, pointerId: 1 });
    fireEvent.pointerUp(pet(), { button: 0, screenX: 140, screenY: 90, pointerId: 1 });
    expect(core.called("pet_drag_move")[0].args).toEqual({ dx: 40, dy: -10 });
    expect(core.called("toggle_panel")).toHaveLength(0);
  });

  it("changes mood with what Claude is doing", async () => {
    const { core } = await open();
    await core.send("user", "check my github");
    expect(pet().className).toContain("thinking");
    await core.send("tool", "mcp__sidekick__github_inbox");
    expect(pet().className).toContain("fetching");
    await core.send("delta", "You have 2 PRs");
    expect(pet().className).toContain("talking");
    await core.send("done", null);
    expect(pet().className).toContain("happy");
    await core.send("failure", "Claude Code stopped");
    expect(pet().className).toContain("sad");
  });

  it("rings the bell for a due reminder and shows it in the bubble", async () => {
    const { core } = await open();
    await core.send("reminder", reminder({ text: "Drink water" }));
    expect(pet().className).toContain("alert");
    expect(card().hidden).toBe(false);
    expect(within(card()).getByText("⏰ Drink water")).toBeTruthy();
  });

  it("lists notifications, opens web links, and clears or dismisses them", async () => {
    const { core, user } = await open({
      notifications: [
        notification({ id: "n1", kind: "task", title: "Review PR #12", link: "https://github.com/me/app/pull/12" }),
        notification({ id: "n2", kind: "sync", title: "Sync done: 3 new tasks", link: "javascript:alert(1)" }),
      ],
    });
    const items = () => Array.from(card().querySelectorAll(".n-item .n-title"), (t) => t.textContent);
    await waitFor(() => expect(items()).toEqual(["Review PR #12", "Sync done: 3 new tasks"]));
    const links = card().querySelectorAll(".n-list a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://github.com/me/app/pull/12");

    await user.click(within(card()).getAllByTitle("Dismiss")[1]);
    expect(core.called("notification_delete")[0].args).toEqual({ id: "n2" });
    expect(items()).toEqual(["Review PR #12"]);
    await user.click(within(card()).getByText("Clear"));
    expect(core.called("notifications_clear")).toHaveLength(1);
    expect(items()).toEqual([]);
  });

  it("pops the bubble up for new notifications only when that's switched on", async () => {
    const { core } = await open({ config: config({ notifier: { autoShow: false, hideAfterSeconds: 12 } }) });
    await core.send("notify", notification({ id: "x", title: "Quiet" }));
    expect(card().hidden).toBe(true);
    await core.send("config", config());
    await core.send("notify", notification({ id: "y", title: "Loud" }));
    expect(card().hidden).toBe(false);
  });

  it("tells the shell which parts catch the mouse (the rest clicks through)", async () => {
    const { core } = await open();
    await waitFor(() => expect(core.called("pet_hit_rects").length).toBeGreaterThan(0));
    expect(Array.isArray(core.called("pet_hit_rects")[0].args.rects)).toBe(true);
  });

  it("looks sad and says so when Claude Code is missing", async () => {
    await open({ status: { state: "missing", model: null, connectors: [] } });
    await waitFor(() => expect(pet().className).toContain("sad"));
    expect(within(card()).getByText(/can't find Claude Code/)).toBeTruthy();
  });
});
