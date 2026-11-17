import { describe, expect, it, vi } from "vitest";
import { hello, task } from "../test/fixtures";
import { fakeCore } from "../test/tauri";
import { onShell, subscribe } from "./events";

describe("subscribe", () => {
  it("delivers the snapshot first, then live events, until unsubscribed", async () => {
    const core = fakeCore({ hello: () => hello({ tasks: [task()] }) });
    const seen: string[] = [];
    const stop = subscribe({
      hello: (h) => seen.push(`hello:${h.tasks.length}`),
      delta: (d) => seen.push(`delta:${d}`),
    });
    await vi.waitFor(() => expect(seen).toEqual(["hello:1"]));

    await core.send("delta", "Hi");
    await core.send("tool", "mcp__sidekick__add_task"); // no handler: ignored
    await vi.waitFor(() => expect(seen).toEqual(["hello:1", "delta:Hi"]));

    stop();
    await core.send("delta", "after");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["hello:1", "delta:Hi"]);
  });

  it("keeps working when the snapshot fails", async () => {
    const core = fakeCore({ hello: () => Promise.reject("core not ready") });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const stop = subscribe({ hello: () => seen.push("hello"), note: (n) => seen.push(n) });
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    await core.send("note", "still listening");
    await vi.waitFor(() => expect(seen).toEqual(["still listening"]));
    stop();
  });
});

describe("onShell", () => {
  it("passes shell events for this window through", async () => {
    const core = fakeCore();
    const got: boolean[] = [];
    const stop = onShell<boolean>("panel-state", (open) => got.push(open));
    await vi.waitFor(async () => {
      await core.shell("panel-state", true);
      expect(got.length).toBeGreaterThan(0);
    });
    expect(got.at(-1)).toBe(true);
    stop();
  });
});
