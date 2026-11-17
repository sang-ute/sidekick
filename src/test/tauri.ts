// A fake Rust core for UI tests, built on Tauri's own mocks: commands are answered by
// the handlers you pass (others return null), and events are pushed with `send`.
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act } from "react";
import type { EventMap, EventName } from "../lib/types";

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}
type Handler = (args: Record<string, unknown>) => unknown;

export function fakeCore(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      const handler = handlers[cmd];
      return handler ? handler(args) : null;
    },
    { shouldMockEvents: true },
  );
  return {
    calls,
    /** Calls of one command, oldest first. */
    called: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    /** Pushes a core event (the "sidekick" event) to every window, inside act(). */
    send: async <K extends EventName>(type: K, data: EventMap[K]) => {
      await act(async () => {
        await emit("sidekick", { type, data });
      });
    },
    /** Pushes a desktop-shell event ("panel-state", "pet-cursor"). */
    shell: async (name: "panel-state" | "pet-cursor", payload: unknown) => {
      await act(async () => {
        await emit(name, payload);
      });
    },
  };
}
