// A tiny client for the WebView2 DevTools protocol (Chrome DevTools Protocol), enough to
// drive Sidekick's real windows: evaluate code, click, type, call Tauri commands, take
// screenshots. Node 22+ has WebSocket built in.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy; returns that value. */
export async function waitFor(fn, { timeout = 15000, interval = 200, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

export async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}

/** Connects to the first page whose URL matches (string contains, or RegExp). */
export async function connect(port, match, timeout = 20000) {
  const t = await waitFor(
    async () => (await targets(port)).find((x) => (match instanceof RegExp ? match.test(x.url) : x.url.includes(match))),
    { timeout, what: `a window matching ${match}` },
  );
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`couldn't connect to ${t.url}`)), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const page = {
    url: t.url,
    /** Evaluates an expression in the page (awaits promises) and returns its JSON value. */
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description || String(ex.exception?.value ?? ex.text ?? "eval failed"));
      return r.result?.result?.value;
    },
    /** Calls a Tauri command from this window, like the UI does. */
    invoke(cmd, args = {}) {
      return page.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
    },
    exists(selector) {
      return page.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
    },
    text(selector) {
      return page.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    },
    texts(selector) {
      return page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);
    },
    visible(selector) {
      return page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.closest("[hidden]"); })()`);
    },
    click(selector) {
      return page.eval(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("nothing matches ${selector.replace(/"/g, "'")}"); e.click(); return true; })()`,
      );
    },
    /** Clicks the first element matching `selector` whose text contains `text`. */
    clickText(selector, text) {
      return page.eval(
        `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) throw new Error("no ${selector.replace(/"/g, "'")} with that text"); e.click(); return true; })()`,
      );
    },
    /** Sets a React-controlled input/textarea value the way typing does. */
    type(selector, value) {
      return page.eval(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) throw new Error("nothing matches ${selector.replace(/"/g, "'")}");
        e.focus();
        const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(e, ${JSON.stringify(value)});
        e.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
    },
    press(selector, key, extra = {}) {
      return page.eval(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })), true`,
      );
    },
    async screenshot(file) {
      const { writeFileSync } = await import("node:fs");
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, "base64"));
      return file;
    },
    close() {
      ws.close();
    },
  };
  // A window shows up in the DevTools list as soon as it starts loading. Wait until the page has
  // loaded, Tauri's bridge is in place and React has rendered, so a test never talks to a
  // half-loaded window (WebView2 starts slowly on a fresh CI machine).
  await waitFor(
    () =>
      page.eval(
        `document.readyState === "complete" && typeof window.__TAURI_INTERNALS__?.invoke === "function" && !!document.getElementById("root")?.firstElementChild`,
      ),
    { timeout, what: `${t.url} to finish loading` },
  );
  return page;
}
