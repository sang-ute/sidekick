# Sidekick

A cute desktop companion for Windows that runs on **your own Claude Code login** (Pro/Max plan).
No API key. A little blue mascot lives on your screen: it blinks, watches your cursor, hops around,
naps when you're away, thinks while Claude works, sends out signal waves while it fetches your data,
and rings a bell when a reminder is due. Click it to chat.

![Sidekick: the task board and the mascot with its notifier](docs/screenshots/hero.png)

![The mascot's moods: idle, handling a request, fetching data, answering, reminding, napping](docs/screenshots/mascot-moods.png)

Built with **Tauri 2 (Rust)** and **React + TypeScript**: a ~2 MB installer, low memory use, and
no local network port.

## Install

Requirement: Claude Code installed and signed in (run `claude` in a terminal once).

1. Download **Sidekick_<version>_x64-setup.exe** from [Releases](../../releases) and run it.
   Windows SmartScreen may warn because the app isn't code-signed: click **More info → Run anyway**.
2. Sidekick starts right away, and from then on at every Windows login.

**Upgrading from 0.x:** uninstall the old Sidekick first (Windows Settings → Apps → Sidekick), so
only one copy starts at login. Your tasks, reminders, notifications and settings carry over: 1.0
uses the same data folder (`%APPDATA%\Sidekick`) and file formats.

## Use it

- **Click the mascot** to open or close the chat. **Drag** it anywhere. **Right-click** it for the menu.
- **Ctrl+Shift+Space** toggles the chat from anywhere; **Esc** closes it.
- Try: *"remind me in 2 minutes to drink water"*, *"every weekday at 9 remind me to check job boards"*.

<p><img src="docs/screenshots/chat-dark.png" width="320" alt="Chat window in dark mode with a formatted answer from Claude Code"></p>

## Notifier

A chat-bubble mini dashboard above the mascot. It pops up when something happens (a reminder fires,
a sync finishes, Claude pins a new task) and when you hover the mascot. It shows your open tasks, the
next reminder and the last sync, plus a list of recent notifications you can open or dismiss.

![The notifier in light and dark mode](docs/screenshots/notifier.png)

## Settings

Click ⚙ (chat window or notifier), or right-click the mascot → **Settings…**

| Tab | What's there |
|---|---|
| General | Theme (system / light / dark), start with Windows, keyboard shortcut, daily sync time |
| AI & Account | Claude Code sign-in (Claude subscription or Anthropic Console), model, effort, response style, reply language |
| Connections | GitHub / YouTube / Gmail / Calendar / web on-off, claude.ai connectors (authorize), your own MCP servers, auto-approved tools, YouTube channels |
| Mascot & notifications | Show/hide, size, nap timer, notifier behaviour, custom mascot image |
| About | Versions, Claude Code path, data folder, copy diagnostics |

Sidekick runs on Claude Code, so it uses Claude models only.

| | |
|---|---|
| ![General settings](docs/screenshots/settings-general.png) | ![AI and account settings](docs/screenshots/settings-ai.png) |
| ![Connections settings](docs/screenshots/settings-connections.png) | ![Mascot and alerts settings](docs/screenshots/settings-mascot.png) |

## Task board

The chat window opens on **📌 Tasks**, a sticky-note board of things you need to do.

- Add your own, tick them off, or remove them. Finished tasks fold away and are cleared after a week.
- **🔄 Sync** asks Claude Code to check GitHub, Gmail and YouTube and pin anything that needs you,
  with a link to open it. A sync also runs every day at the time set in Settings (default 08:30),
  or right after login if the PC was off at that time.
- Claude can manage the board from chat too: *"add a task to email my professor"*, *"what's on my plate?"*.
- The mascot carries a little sticky note with your open-task count.

<p><img src="docs/screenshots/tasks-light.png" width="320" alt="Task board with sticky notes from Gmail, GitHub, YouTube and Calendar"></p>

## Connections

| Service | How | Setup |
|---|---|---|
| GitHub | Your `gh` CLI login (read-only): PRs waiting for your review, assigned issues, your PRs, notifications | `gh auth login` once |
| Gmail, Google Calendar | claude.ai connectors, used by Claude Code | claude.ai → Settings → Connectors → connect them |
| YouTube | Public channel feeds, no account needed | Say *"follow @fireship on YouTube"* |

Sidekick never sends, deletes or changes anything unless you ask in the chat.

## Custom mascot

Put an image named `mascot.png`, `mascot.gif` or `mascot.webp` (about 120×120, transparent background,
up to 5 MB) in the data folder (right-click mascot → Open data folder) and restart. It gets the same
hops, jumps and naps as the built-in one.

## How it works

```
Windows login
 └─ Sidekick.exe  (Rust, Tauri 2)
     ├─ core: chat history, notifications, task board, reminders (checked every 15 s), daily sync
     │    └─ claude -p  (your Claude Code login, one long-lived session)
     │         ├─ Sidekick.exe --mcp   → reminders, task board, GitHub, YouTube tools
     │         ├─ WebSearch, WebFetch
     │         └─ your claude.ai connectors (Gmail, Calendar, Drive… once authorized on claude.ai)
     └─ windows (React + TypeScript in WebView2): mascot + notifier, chat, settings; tray icon
```

The windows talk to the Rust core over Tauri's built-in IPC. There is no local web server, so no
port that other programs or web pages could reach.

## Safety defaults

- No network server; the UI can only call Sidekick's own commands (Tauri capabilities), not the
  file system or shell. The content security policy only allows Sidekick's own scripts.
- Claude Code gets only WebSearch and WebFetch as built-in tools: no shell, no file edits. Connector
  tools are blocked until you allow them in Settings.
- Links in chat, tasks and notifications open in your normal browser, never inside Sidekick.

## Config file

Everything in Settings is saved to `%APPDATA%\Sidekick\config.json` and applied right away
(changes to model, effort, style, language, tools or MCP servers restart Claude Code, keeping the chat).
Editing the file by hand also works; Sidekick picks the change up within a couple of seconds.

## Develop

Requirements: Node 22+, Rust 1.100 (via rustup) and the Microsoft C++ Build Tools with the Windows SDK.

```bash
npm install
npm run dev        # run with hot reload (Vite + Tauri)
npm run build      # release build + installer → src-tauri/target/release/bundle/nsis/
npm run check      # everything CI runs: lint, types, unit, integration and end-to-end tests
npm run format     # format the Rust code (rustfmt)
npm run icon       # redraw the app icon and regenerate the Windows icons
```

### Tests

| Command | What it checks |
|---|---|
| `npm run lint` | UI and scripts with oxlint (type-aware, warnings fail); Rust with rustfmt and clippy |
| `npm run typecheck` | TypeScript |
| `npm run test:ui` | Vitest + Testing Library: the chat panel, mascot and settings windows, markdown safety, the bridge to the Rust core (faked with Tauri's own IPC mocks) |
| `npm run test:rust` | Rust unit tests, plus integration tests that run the real `sidekick --mcp` server and the real Claude Code bridge against a fake Claude Code |
| `npm run e2e:build`, then `npm run e2e` | End to end: a test copy of the app (its own data folder and WebView2 profile, a fake Claude Code) driven through its real windows. It also fails if any console or terminal window appears. Results, screenshots and logs go to `e2e-artifacts/`. It runs next to an installed Sidekick without touching it. Add `-- --real-claude` to use your signed-in Claude Code instead. |

The fake Claude Code (`src-tauri/src/fake_claude.rs`) speaks Claude Code's stream-json protocol and calls Sidekick's real MCP server, so tests cover the whole chat → tool → task board → notification path without a login. It's behind the `test-support` Cargo feature: release builds never include it.

### CI/CD

All on GitHub Actions' free tier. Sidekick is a desktop app, so there's no server or cloud infrastructure to provision (and no Terraform).

- **CI** (`.github/workflows/ci.yml`), on pull requests and pushes to `master`:
  - a Linux job: type check, UI lint and tests, Rust formatting, workflow lint (actionlint), and security audits of the npm packages and Rust crates the app ships;
  - a Windows job: clippy, Rust unit and integration tests, then the end-to-end suite against the built app. Its `e2e-artifacts` are uploaded with every run.
- **Release** (`.github/workflows/release.yml`): bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a matching tag (`git tag v1.2.3 && git push origin v1.2.3`). It tests, builds the installer and creates a **draft** GitHub release with the installer and its SHA-256. You review and publish it.
- **Dependabot** opens weekly grouped updates for npm, Cargo and the workflow actions. Third-party actions are pinned to exact commits.
- **Free minutes:** private repositories get 2,000 Actions minutes a month, and Windows minutes count double. Check Settings → Billing after the first few runs to see what a run costs. The Rust toolchain version for CI is set once at the top of each workflow (`RUST_VERSION`).

| Path | Role |
|---|---|
| `src-tauri/src/core.rs` | Chat history, notification feed, sync, scheduler, file watching, settings, info |
| `src-tauri/src/claude.rs` | Runs and talks to the Claude Code CLI (`stream-json` mode), system prompt |
| `src-tauri/src/mcp.rs` | Sidekick's MCP tool server (`Sidekick.exe --mcp`, JSON-RPC over stdio) |
| `src-tauri/src/shell.rs` | Windows, click-through, eye tracking, dragging, tray, menus, shortcut, autostart, theme |
| `src-tauri/src/commands.rs` | Commands the UI calls |
| `src-tauri/src/config.rs` | Settings defaults, choices and validation |
| `src-tauri/src/store.rs` | Tasks and reminders storage |
| `src-tauri/src/integrations.rs` | GitHub (via `gh`) and YouTube (RSS) readers |
| `src/panel/` | Chat + task board window (React) |
| `src/mascot/` | The mascot (SVG + CSS animations, moods) and the notifier (React) |
| `src/settings/` | Settings window (React) |
| `src/lib/` | Typed bridge to the Rust commands, live events, markdown, shared types |
| `src-tauri/src/fake_claude.rs` | Stand-in Claude Code for tests (`test-support` feature only) |
| `src-tauri/tests/` | Integration tests: MCP server, Claude Code bridge |
| `src/**/*.test.ts(x)`, `src/test/` | UI tests and their fake Rust core |
| `scripts/e2e/` | End-to-end runner, DevTools driver, window watcher, specs |
| `.github/` | CI, release and Dependabot configuration |

## Roadmap

- [ ] Smarter heartbeat: nudge during the day only when something urgent arrives
- [ ] Approve or deny a tool the moment Claude asks for it
- [ ] Telegram channel to message it from your phone
- [ ] More mascot moods and outfits
