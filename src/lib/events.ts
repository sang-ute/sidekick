// Live updates from the Rust core. One Tauri event, "sidekick", carries { type, data };
// a window first gets a full snapshot (hello), then every change.
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { EventMap, EventName, Hello } from "./types";

export type Handlers = { [K in EventName]?: (data: EventMap[K]) => void };

/** Subscribe to the core. Calls handlers.hello with a snapshot first. Returns an unsubscribe. */
export function subscribe(handlers: Handlers): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  // Listen first, then take the snapshot, so nothing that happens in between is missed.
  void listen<{ type: EventName; data: unknown }>("sidekick", (e) => {
    const fn = handlers[e.payload.type] as ((d: unknown) => void) | undefined;
    fn?.(e.payload.data);
  }).then(async (u) => {
    if (stopped) return u();
    unlisten = u;
    try {
      const hello: Hello = await api.hello();
      if (!stopped) handlers.hello?.(hello);
    } catch (err) {
      console.error("Sidekick: couldn't load state", err);
    }
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Desktop-shell events aimed at one window (panel open/closed, cursor offset for the eyes). */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the payload type
export function onShell<T>(name: "panel-state" | "pet-cursor", fn: (data: T) => void): () => void {
  let un: (() => void) | null = null;
  let stopped = false;
  void listen<T>(name, (e) => fn(e.payload)).then((u) => (stopped ? u() : (un = u)));
  return () => {
    stopped = true;
    un?.();
  };
}
