import { describe, expect, it } from "vitest";
import { fakeCore } from "../test/tauri";
import { api, shell } from "./api";

describe("api", () => {
  it("calls the right command with the right arguments", async () => {
    const core = fakeCore({ task_update: (a) => ({ id: a.id, done: a.done }) });
    await expect(api.updateTask("t1", { done: true })).resolves.toEqual({ id: "t1", done: true });
    await api.patchSettings({ theme: "dark" });
    await shell.hitRects([{ x: 1, y: 2, w: 3, h: 4 }]);
    expect(core.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["task_update", { id: "t1", done: true }],
      ["settings_patch", { patch: { theme: "dark" } }],
      ["pet_hit_rects", { rects: [{ x: 1, y: 2, w: 3, h: 4 }] }],
    ]);
  });

  it("turns the core's error text into an Error with that message", async () => {
    // A Rust command returning Err(String) rejects with the plain string.
    fakeCore({ settings_patch: () => Promise.reject('shortcut should look like "Control+Shift+Space"') });
    const err = await api.patchSettings({ shortcut: "banana" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('shortcut should look like "Control+Shift+Space"');
    expect((err as Error).cause).toBe('shortcut should look like "Control+Shift+Space"');
  });

  it("keeps the message of a thrown Error", async () => {
    fakeCore({ sync: () => Promise.reject(new Error("Busy, try again in a moment")) });
    await expect(api.sync()).rejects.toThrow("Busy, try again in a moment");
  });
});
