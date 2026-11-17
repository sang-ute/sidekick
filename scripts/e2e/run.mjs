#!/usr/bin/env node
// End-to-end tests for Sidekick.
//
// Starts a test copy of the real app (its own temporary data folder and WebView2 profile,
// and by default a fake Claude Code built into the test executable), drives its real
// windows over the WebView2 DevTools protocol, and watches the desktop the whole time to
// make sure Sidekick never opens a console or terminal window. Your installed Sidekick and
// your real data are left alone.
//
//   npm run e2e:build      # debug build with the frontend embedded and the fake Claude Code
//   npm run e2e            # run every spec in scripts/e2e/specs
//   node scripts/e2e/run.mjs --only chat --keep    # one spec, keep the app open afterwards
//   node scripts/e2e/run.mjs --real-claude         # use your installed, signed-in Claude Code
//   node scripts/e2e/run.mjs --shard 2/3           # every 3rd spec file, starting with the 2nd (CI)
//
// Results, screenshots of failures, the app log and the window log go to e2e-artifacts/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, sleep, targets, waitFor } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const opts = {
  app: resolve(value("--app") || join(root, "src-tauri/target/debug/sidekick.exe")),
  only: value("--only"),
  keep: flag("--keep"),
  realClaude: flag("--real-claude"),
  shard: value("--shard") || "1/1",
};
const [shardIndex, shardCount] = opts.shard.split("/").map(Number);
if (!(shardCount >= 1 && shardIndex >= 1 && shardIndex <= shardCount)) {
  console.error(`--shard should look like 2/3, got ${opts.shard}`);
  process.exit(1);
}
const strictWindows = Boolean(process.env.CI); // on CI any new terminal window fails the run

if (process.platform !== "win32") {
  console.log("Sidekick's end-to-end tests need Windows (WebView2). Skipped.");
  process.exit(0);
}
if (!existsSync(opts.app)) {
  console.error(`No app at ${opts.app}\nBuild it first: npm run e2e:build`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runId = `e2e-${Date.now().toString(36)}`; // marks everything this run creates
const artifacts = join(root, "e2e-artifacts");
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "sidekick-e2e-"));
const realDataDir = join(process.env.APPDATA || "", "sidekick");

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const readLines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l.replace(/^﻿/, ""))];
          } catch {
            return [];
          }
        })
    : [];
const killTree = (pid) => {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // already gone
  }
};

// ---------- watcher: every new process and window during the run ----------
const windowLog = join(artifacts, "windows.jsonl");
const watcher = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "lib", "watch-windows.ps1"), "-Log", windowLog],
  { stdio: "ignore", windowsHide: true },
);
await waitFor(() => readLines(windowLog).some((l) => l.kind === "ready"), { timeout: 60000, what: "the window watcher" });

// ---------- the app under test ----------
const port = await freePort();
const env = {
  ...process.env,
  SIDEKICK_TEST: "1",
  SIDEKICK_DATA: dataDir,
  SIDEKICK_DEVTOOLS_PORT: String(port),
  SIDEKICK_LOG: "1",
};
if (!opts.realClaude) Object.assign(env, { SIDEKICK_FAKE_CLAUDE: "1", SIDEKICK_CLAUDE_PATH: opts.app });
const appLog = createWriteStream(join(artifacts, "app.log"));
const app = spawn(opts.app, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
app.stdout.pipe(appLog);
app.stderr.pipe(appLog);
let appExit = null;
app.on("exit", (code) => (appExit = code));
console.log(`Sidekick ${pkg.version} under test: ${opts.app}`);
console.log(`  data ${dataDir}, DevTools port ${port}, ${opts.realClaude ? "real" : "fake"} Claude Code, run ${runId}\n`);

// ---------- context for the specs ----------
const windows = {};
const PAGES = {
  mascot: "mascot.html",
  panel: /\/\/tauri\.localhost\/(index\.html)?([?#].*)?$/,
  settings: "settings.html",
};
const ctx = {
  runId,
  dataDir,
  version: pkg.version,
  fake: !opts.realClaude,
  assert,
  sleep,
  waitFor,
  /** A connection to one of the app's windows ("mascot", "panel", "settings"). */
  async win(name) {
    if (!windows[name]) windows[name] = await connect(port, PAGES[name], 30000);
    return windows[name];
  },
  /** Forgets a window (after it closes). */
  forget(name) {
    windows[name]?.close();
    delete windows[name];
  },
  async invoke(cmd, args) {
    return (await ctx.win("mascot")).invoke(cmd, args);
  },
  readData(file) {
    const p = join(dataDir, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  },
  async hasWindow(name) {
    const match = PAGES[name];
    return (await targets(port)).some((t) => (match instanceof RegExp ? match.test(t.url) : t.url.includes(match)));
  },
};

// ---------- run the specs ----------
const results = [];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function record(spec, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ spec, name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ spec, name, ok: false, ms: Date.now() - started, error: e.stack || String(e) });
    console.log(`  FAIL  ${name}\n        ${String(e.message || e).split("\n").join("\n        ")}`);
    for (const [w, page] of Object.entries(windows)) {
      await page.screenshot(join(artifacts, `${slug(spec)}-${slug(name)}-${w}.png`)).catch(() => {});
    }
  }
}

try {
  await waitFor(async () => (await targets(port)).some((t) => t.url.includes("mascot.html")), {
    timeout: 60000,
    what: "the app's windows (is WebView2 installed?)",
  });
  // Ready means: the mascot and chat windows have loaded and the core answers.
  await ctx.win("mascot");
  await ctx.win("panel");
  await waitFor(async () => (await ctx.invoke("hello")).config, { timeout: 30000, what: "the core to answer" });
  const specDir = join(here, "specs");
  // Spec files are dealt round-robin to the shards; each shard runs its own app instance.
  const files = readdirSync(specDir)
    .filter((f) => f.endsWith(".mjs") && (!opts.only || f.includes(opts.only)))
    .toSorted()
    .filter((_, i) => i % shardCount === shardIndex - 1);
  if (shardCount > 1) console.log(`shard ${opts.shard}: ${files.join(", ")}\n`);
  for (const file of files) {
    const spec = file.replace(/^\d+-|\.mjs$/g, "");
    console.log(spec);
    const tests = [];
    const mod = await import(pathToFileURL(join(specDir, file)).href);
    mod.default((name, fn, { fakeOnly = false } = {}) => tests.push({ name, fn, fakeOnly }));
    for (const t of tests) {
      if (t.fakeOnly && !ctx.fake) {
        console.log(`  skip  ${t.name} (needs the fake Claude Code)`);
        continue;
      }
      if (appExit !== null) throw new Error(`The app exited (code ${String(appExit)}); see e2e-artifacts/app.log`);
      await record(spec, t.name, () => t.fn(ctx));
    }
  }
} catch (e) {
  results.push({ spec: "runner", name: "the app starts and stays up", ok: false, error: e.stack || String(e) });
  console.log(`  FAIL  ${e.message}`);
} finally {
  for (const page of Object.values(windows)) page.close();
  if (opts.keep) {
    console.log(`\n--keep: the app is still running (PID ${app.pid}), data in ${dataDir}`);
  } else {
    killTree(app.pid);
  }
  await sleep(500);
  killTree(watcher.pid);
}

// ---------- checks over the whole run ----------
console.log("whole run");
await record("whole run", "no console or terminal window ever appeared", () => {
  const lines = readLines(windowLog);
  const parent = new Map(lines.filter((l) => l.kind === "proc").map((l) => [l.pid, l.ppid]));
  const ours = (pid) => {
    for (let p = pid, i = 0; p && i < 50; p = parent.get(p), i++) if (p === app.pid) return true;
    return false;
  };
  const TERMINALS = new Set(["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow"]);
  const APP_WINDOWS = new Set(["Tauri Window", "Tao Thread Event Target"]);
  const spawned = lines.filter((l) => l.kind === "proc" && ours(l.pid));
  const bad = [];
  const elsewhere = [];
  for (const w of lines.filter((l) => l.kind === "window")) {
    const mine = ours(w.pid);
    if (mine && !APP_WINDOWS.has(w.cls)) bad.push(w);
    else if (TERMINALS.has(w.cls)) (strictWindows ? bad : elsewhere).push(w);
  }
  writeFileSync(join(artifacts, "processes.json"), JSON.stringify(spawned, null, 2));
  for (const w of elsewhere) console.log(`        note: a terminal window appeared outside Sidekick: "${w.title}" (${w.name})`);
  assert.ok(spawned.length > 0, "the watcher saw the app's child processes");
  assert.deepEqual(bad.map((w) => `${w.cls} "${w.title}" from ${w.name} (${w.pid})`), []);
});
await record("whole run", "your real Sidekick data was not touched", () => {
  if (!existsSync(realDataDir)) return;
  for (const file of readdirSync(realDataDir).filter((f) => f.endsWith(".json"))) {
    const text = readFileSync(join(realDataDir, file), "utf8");
    assert.ok(!text.includes(runId), `${file} in ${realDataDir} contains data from this test run`);
  }
});

const failed = results.filter((r) => !r.ok);
writeFileSync(join(artifacts, "results.json"), JSON.stringify({ runId, version: pkg.version, shard: opts.shard, results }, null, 2));
if (!opts.keep) rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
