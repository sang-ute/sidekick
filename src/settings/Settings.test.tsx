import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { config, hello, info, options, PRIVATE_EMAIL } from "../test/fixtures";
import { fakeCore } from "../test/tauri";
import type { Config } from "../lib/types";
import { Settings } from "./Settings";

/** The settings window over a fake core that stores patches like the real one. */
async function open(over: Partial<Config> = {}, handlers: Parameters<typeof fakeCore>[0] = {}) {
  let current = config(over);
  const core = fakeCore({
    hello: () => hello({ config: current }),
    settings_get: () => ({ config: current, defaults: config(), options }),
    settings_patch: (a) => (current = { ...current, ...(a.patch as Partial<Config>) }),
    info: () => info(),
    ...handlers,
  });
  render(<Settings />);
  await screen.findByRole("radio", { name: "System" });
  return { core, user: userEvent.setup(), config: () => current };
}
const panel = (id: string) => document.getElementById(`panel-${id}`)!;
const toast = () => document.querySelector<HTMLElement>(".toast")!;

describe("Settings", () => {
  it("switches tabs with clicks and arrow keys, and remembers the tab", async () => {
    const { user } = await open();
    expect(panel("general").hidden).toBe(false);
    await user.click(screen.getByRole("tab", { name: /About/ }));
    expect(panel("about").hidden).toBe(false);
    expect(panel("general").hidden).toBe(true);
    fireEvent.keyDown(screen.getByRole("tab", { name: /About/ }), { key: "ArrowUp" });
    expect(panel("mascot").hidden).toBe(false);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Mascot/ }), { key: "Home" });
    expect(panel("general").hidden).toBe(false);
    expect(sessionStorage.getItem("sidekick-settings-tab")).toBe("general");
  });

  it("saves a change right away and confirms it", async () => {
    const { core, user, config: saved } = await open();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(core.called("settings_patch")[0].args).toEqual({ patch: { theme: "dark" } });
    await waitFor(() => expect(toast().textContent).toBe("Saved ✓"));
    expect(saved().theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("rolls back and shows the core's message when a change is rejected", async () => {
    const { user } = await open({}, { settings_patch: () => Promise.reject("Unknown setting \"x\"") });
    await user.click(screen.getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(toast().textContent).toBe('Unknown setting "x"'));
    expect(toast().className).toContain("err");
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves through a segmented control with the arrow keys", async () => {
    const { core } = await open();
    fireEvent.keyDown(screen.getByRole("radio", { name: "System" }), { key: "ArrowRight" });
    await waitFor(() => expect(core.called("settings_patch")[0]?.args).toEqual({ patch: { theme: "light" } }));
  });

  it("only saves a keyboard shortcut once it's valid", async () => {
    const { core, user } = await open();
    const field = screen.getByLabelText<HTMLInputElement>(/Keyboard shortcut/);
    await user.clear(field);
    await user.type(field, "banana");
    expect(screen.getByText(/Use modifiers and a key/).hidden).toBe(false);
    await new Promise((r) => setTimeout(r, 800));
    expect(core.called("settings_patch")).toHaveLength(0);
    await user.clear(field);
    await user.type(field, "Control+Alt+K");
    await waitFor(() => expect(core.called("settings_patch").at(-1)?.args).toEqual({ patch: { shortcut: "Control+Alt+K" } }), { timeout: 2000 });
  });

  it("shows account, versions and connectors from the core", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("tab", { name: /AI & account/ }));
    await within(panel("ai")).findByText("Signed in");
    expect(within(panel("ai")).getByText("Claude subscription (claude.ai)")).toBeTruthy();
    expect(within(panel("ai")).getByText("Max")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /About/ }));
    const rows = Object.fromEntries(
      Array.from(panel("about").querySelectorAll("dt"), (dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(rows).toMatchObject({
      Version: "1.0.1",
      Tauri: "2.12.5",
      WebView2: "157.0.0.0",
      Platform: "Windows 10.0.26200 x86_64",
      "Claude Code": "v2.9.0 (Claude Code)",
      "GitHub CLI": "Signed in as @octocat",
    });

    await user.click(screen.getByRole("tab", { name: /Connections/ }));
    expect(within(panel("connections")).getByText("@octocat")).toBeTruthy();
    expect(within(panel("connections")).getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("copies diagnostics without the email address", async () => {
    const { user } = await open();
    const writeText = vi.spyOn(navigator.clipboard, "writeText"); // user-event's clipboard
    await user.click(screen.getByRole("tab", { name: /About/ }));
    await within(panel("about")).findByText("2.12.5");
    await user.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0][0];
    expect(text).toContain("Sidekick 1.0.1");
    expect(text).toContain("Claude auth: signed in (Claude subscription (claude.ai), max)");
    expect(text).not.toContain(PRIVATE_EMAIL);
    expect(text).not.toContain("octocat");
  });

  it("adds a custom MCP server and rejects bad input", async () => {
    const { core, user } = await open();
    await user.click(screen.getByRole("tab", { name: /Connections/ }));
    await user.click(screen.getByText("＋ Add server"));
    const form = panel("connections").querySelector<HTMLFormElement>("form.form")!;
    await user.type(within(form).getByPlaceholderText("notion"), "files");
    await user.type(within(form).getByPlaceholderText("npx"), "npx");
    await user.type(within(form).getByPlaceholderText(/server-filesystem/), '-y fs-server "C:\\My Notes"');
    await user.type(within(form).getByPlaceholderText("API_KEY=…"), "1BAD=x");
    await user.click(within(form).getByRole("button", { name: "Add server" }));
    expect(await within(form).findByText(/isn't a valid variable name/)).toBeTruthy();
    expect(core.called("settings_patch")).toHaveLength(0);

    await user.clear(within(form).getByPlaceholderText("API_KEY=…"));
    await user.type(within(form).getByPlaceholderText("API_KEY=…"), "ROOT=C:\\notes");
    await user.click(within(form).getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(core.called("settings_patch")).toHaveLength(1));
    expect(core.called("settings_patch")[0].args).toEqual({
      patch: { mcpServers: { files: { type: "stdio", command: "npx", args: ["-y", "fs-server", "C:\\My Notes"], env: { ROOT: "C:\\notes" } } } },
    });
  });

  it("flushes a pending text change and closes on Esc", async () => {
    const { core, user } = await open();
    await user.click(screen.getByRole("tab", { name: /AI & account/ }));
    await user.type(screen.getByLabelText(/Reply language/), "Vietnamese");
    await user.keyboard("{Escape}");
    // Saves run one after another, so the flushed one may still be queued.
    await waitFor(() => expect(core.called("settings_patch").at(-1)?.args).toEqual({ patch: { language: "Vietnamese" } }));
    expect(core.called("close_settings")).toHaveLength(1);
  });
});
