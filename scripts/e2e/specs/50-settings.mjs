// The settings window: tabs, saving, theme everywhere, About, validation, restart, Esc.
import { chat, openPanel } from "../lib/app.mjs";

const pick = (s, tab, label) => s.clickText(`#panel-${tab} .seg button[role="radio"]`, label);
const theme = (page) => page.eval(`document.documentElement.dataset.theme || "system"`);

export default (test) => {
  test("opens from the chat window and shows every tab", async (ctx) => {
    const p = await openPanel(ctx);
    await p.click('.actions button[title="Settings"]');
    const s = await ctx.win("settings");
    for (const tab of ["general", "ai", "connections", "mascot", "about"]) {
      await ctx.waitFor(() => s.exists(`#tab-${tab}`), { what: `the ${tab} tab` });
      await s.click(`#tab-${tab}`);
      await ctx.waitFor(() => s.visible(`#panel-${tab}`), { what: `the ${tab} panel` });
    }
  });

  test("a theme change saves and applies to every window", async (ctx) => {
    const { assert, waitFor } = ctx;
    const s = await ctx.win("settings");
    await s.click("#tab-general");
    await pick(s, "general", "Light");
    const p = await ctx.win("panel");
    const m = await ctx.win("mascot");
    await waitFor(async () => (await theme(p)) === "light" && (await theme(m)) === "light" && (await theme(s)) === "light", {
      what: "light theme in all windows",
    });
    assert.equal(ctx.readData("config.json").theme, "light");
    await pick(s, "general", "System");
    await waitFor(() => ctx.readData("config.json").theme === "system", { what: "the theme back to System" });
  });

  test("About shows this version and the platform", async (ctx) => {
    const s = await ctx.win("settings");
    await s.click("#tab-about");
    const rows = await ctx.waitFor(
      async () => {
        const r = await s.eval(`Object.fromEntries([...document.querySelectorAll("#panel-about dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]))`);
        return r.Version ? r : null;
      },
      { what: "the About details" },
    );
    ctx.assert.equal(rows.Version, ctx.version);
    ctx.assert.match(rows.Platform, /^Windows /);
    ctx.assert.match(rows.Tauri, /^2\./);
    if (ctx.fake) ctx.assert.equal(rows["Claude Code"], "v9.9.9");
  });

  test("invalid settings are rejected with a clear message", async (ctx) => {
    const err = await ctx.invoke("settings_patch", { patch: { shortcut: "banana" } }).then(
      () => "",
      (e) => String(e.message || e),
    );
    ctx.assert.match(err, /shortcut/);
    ctx.assert.notEqual(ctx.readData("config.json")?.shortcut, "banana");
  });

  test(
    "changing the effort restarts Claude Code and the chat keeps working",
    async (ctx) => {
      const s = await ctx.win("settings");
      await s.click("#tab-ai");
      await pick(s, "ai", "Medium");
      await ctx.waitFor(() => ctx.readData("config.json").effort === "medium", { what: "effort saved" });
      const msgs = await chat(ctx, "after the restart");
      ctx.assert.equal(msgs.at(-1).text, "Echo: after the restart");
    },
    { fakeOnly: true },
  );

  test("Esc closes the settings window", async (ctx) => {
    const s = await ctx.win("settings");
    await s.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    ctx.forget("settings");
    await ctx.waitFor(async () => !(await ctx.hasWindow("settings")), { what: "settings to close" });
  });
};
