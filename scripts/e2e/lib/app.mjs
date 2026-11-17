// Helpers for driving Sidekick's windows in the e2e specs.
import { waitFor } from "./cdp.mjs";

export const TASKS_TAB = '.tabs button[role="tab"]:nth-child(1)';
export const CHAT_TAB = '.tabs button[role="tab"]:nth-child(2)';

/** Opens the chat window and returns its page. */
export async function openPanel(ctx) {
  await ctx.invoke("open_panel");
  const p = await ctx.win("panel");
  await waitFor(() => p.exists("#panel .tabs"), { what: "the chat window" });
  return p;
}

/** Titles of the open tasks on the board. */
export const boardTitles = (p) => p.texts(".notes:not(.done) .note .title");

/**
 * Sends a chat message through the real composer and waits for the turn to finish.
 * Returns the messages it added: [{ kind: "user" | "bot md" | "note" | "error", text, html }].
 */
export async function chat(ctx, text, timeout = 45000) {
  const p = await openPanel(ctx);
  await p.click(CHAT_TAB);
  await waitFor(async () => !(await p.eval(`document.querySelector(".composer textarea").disabled`)), {
    what: "the composer to be ready",
  });
  const before = await p.eval(`document.querySelectorAll(".log .msg").length`);
  await p.type(".composer textarea", text);
  await p.press(".composer textarea", "Enter");
  await waitFor(
    () =>
      p.eval(`(() => {
        const n = document.querySelectorAll(".log .msg").length;
        return n >= ${before} + 2 && !document.querySelector(".log .thinking") && !document.querySelector(".composer textarea").disabled;
      })()`),
    { timeout, what: `the reply to "${text}"` },
  );
  return p.eval(
    `[...document.querySelectorAll(".log .msg")].slice(${before}).map((m) => ({ kind: m.className.replace(/^msg /, ""), text: m.textContent, html: m.innerHTML }))`,
  );
}
