// The app starts, the core and Claude Code come up, and every window loads.
import { openPanel } from "../lib/app.mjs";

export default (test) => {
  test("the core starts and Claude Code warms up", async ({ invoke, waitFor, assert }) => {
    const hello = await waitFor(
      async () => {
        const h = await invoke("hello");
        return h.status.state === "ready" ? h : null;
      },
      { timeout: 30000, what: "Claude Code to be ready" },
    );
    assert.equal(hello.config.theme, "system");
    assert.deepEqual(hello.tasks, []);
    assert.deepEqual(hello.reminders, []);
  });

  test("About info reports the versions, WebView2 and Claude Code", async ({ invoke, version, fake, assert }) => {
    const info = await invoke("info");
    assert.equal(info.app.version, version);
    assert.match(info.app.tauri, /^2\./);
    assert.ok(info.app.webview, "WebView2 version");
    assert.match(info.app.platform, /^Windows \d+\.\d+\.\d+$/);
    assert.equal(info.claude.found, true);
    if (fake) {
      assert.equal(info.claude.version, "9.9.9", "the version number from `claude --version`");
      assert.equal(info.claude.auth.loggedIn, true);
      const status = Object.fromEntries(info.connectors.map((c) => [c.name, c.status]));
      assert.equal(status["claude.ai Gmail"], "connected");
      assert.equal(status["claude.ai Google Calendar"], "needs-auth");
    }
  });

  test("the mascot, chat and settings windows load", async (ctx) => {
    const { assert, waitFor } = ctx;
    const m = await ctx.win("mascot");
    assert.ok(await m.exists("#pet svg"), "the mascot is drawn");
    const p = await openPanel(ctx);
    assert.match(await p.text("#status"), /^Claude Code/);
    await ctx.invoke("open_settings");
    const s = await ctx.win("settings");
    await waitFor(() => s.exists("#tab-about"), { what: "the settings tabs" });
    await ctx.invoke("close_settings");
    ctx.forget("settings");
    await waitFor(async () => !(await ctx.hasWindow("settings")), { what: "settings to close" });
  });
};
