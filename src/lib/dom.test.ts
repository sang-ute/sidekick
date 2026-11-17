import { beforeAll, describe, expect, it, vi } from "vitest";
import { fakeCore } from "../test/tauri";
import { ago, applyTheme, routeLinksToBrowser, until } from "./dom";

describe("relative times", () => {
  it("say how long ago something happened", () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T12:00:00Z") });
    expect(ago("2026-11-16T11:59:30Z")).toBe("now");
    expect(ago("2026-11-16T11:55:00Z")).toBe("5m ago");
    expect(ago("2026-11-16T09:00:00Z")).toBe("3h ago");
    expect(ago("2026-11-15T10:00:00Z")).toBe("yesterday");
    expect(ago("2026-11-12T12:00:00Z")).toBe("4d ago");
    expect(ago("2026-11-16T13:00:00Z")).toBe("now");
    expect(ago("not a date")).toBe("");
  });

  it("say how long until something happens", () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T12:00:00Z") });
    expect(until("2026-11-16T12:00:30Z")).toBe("now");
    expect(until("2026-11-16T12:25:00Z")).toBe("in 25m");
    expect(until("2026-11-16T14:00:00Z")).toBe("in 2h");
    expect(until("2026-11-16T14:10:00Z")).toBe("in 2h 10m");
    const far = until("2026-11-20T09:30:00Z");
    expect(far).not.toMatch(/^in /);
    expect(far.length).toBeGreaterThan(3);
    expect(until("not a date")).toBe("none");
  });
});

describe("applyTheme", () => {
  it("sets light or dark, and follows Windows otherwise", () => {
    applyTheme({ theme: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme({ theme: "system" });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    applyTheme(null);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("routeLinksToBrowser", () => {
  beforeAll(() => routeLinksToBrowser());

  const click = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.innerHTML = "<span>open</span>";
    document.body.append(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.querySelector("span")!.dispatchEvent(ev);
    a.remove();
    return ev;
  };

  it("opens web links in the real browser, never inside Sidekick", async () => {
    const core = fakeCore();
    expect(click("https://github.com/me/app/pull/12").defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(core.called("open_url")).toHaveLength(1));
    expect(core.called("open_url")[0].args).toEqual({ url: "https://github.com/me/app/pull/12" });
  });

  it("ignores other kinds of links", () => {
    const core = fakeCore();
    expect(click("javascript:alert(1)").defaultPrevented).toBe(true);
    expect(click("file:///C:/Windows").defaultPrevented).toBe(true);
    expect(core.called("open_url")).toHaveLength(0);
  });
});
