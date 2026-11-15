# Sidekick

A cute desktop companion for Windows that runs on **your own Claude Code login** (Pro/Max plan).
No API key. A little coral mascot lives on your screen: it blinks, watches your cursor, hops around,
naps when you're away, thinks while Claude works, and jumps up with a speech bubble when a reminder
is due. Click it to chat.

## Install

Requirement: Claude Code installed and signed in (run `claude` in a terminal once).

1. Run `dist/Sidekick Setup <version>.exe`. Windows SmartScreen may warn because the app isn't
   code-signed: click **More info → Run anyway**.
2. Sidekick starts right away, and from then on at every Windows login.

## Use it

- **Click the mascot** to open or close the chat. **Drag** it anywhere. **Right-click** it for the menu.
- **Ctrl+Shift+Space** toggles the chat from anywhere; **Esc** closes it.
- When the chat is closed, answers and reminders pop up in the mascot's speech bubble.
- Try: *"remind me in 2 minutes to drink water"*, *"every weekday at 9 remind me to check job boards"*.

## Task board

The chat window opens on **📌 Tasks**, a sticky-note board of things you need to do.

- Add your own, tick them off, or remove them. Finished tasks fold away and are cleared after a week.
- **🔄 Sync** asks Claude Code to check GitHub, Gmail and YouTube and pin anything that needs you,
  with a link to open it. A sync also runs every day at `dailySyncTime` (default 08:30), or right
  after login if the PC was off at that time.
- Claude can manage the board from chat too: *"add a task to email my professor"*, *"what's on my plate?"*.
- The mascot carries a little sticky note with your open-task count.

## Connections

| Service | How | Setup |
|---|---|---|
| GitHub | Your `gh` CLI login (read-only): PRs waiting for your review, assigned issues, your PRs, notifications | `gh auth login` once |
| Gmail, Google Calendar | claude.ai connectors, used by Claude Code | claude.ai → Settings → Connectors → connect them |
| YouTube | Public channel feeds, no account needed | Say *"follow @fireship on YouTube"* |

Sidekick never sends, deletes or changes anything unless you ask in the chat.

## Custom mascot

Put an image named `mascot.png`, `mascot.gif` or `mascot.webp` (about 120×120, transparent background)
in the data folder (right-click mascot → Open data folder) and restart. It gets the same hops, jumps
and naps as the built-in one.

## What starts at login

```
Windows login
 └─ Sidekick.exe
     ├─ local server  127.0.0.1:47821  (UI, chat stream, reminders; token-protected)
     │    └─ claude -p  (your Claude Code login, one long-lived session)
     │         ├─ sidekick MCP server  → reminders, task board, GitHub, YouTube
     │         ├─ WebSearch, WebFetch
     │         └─ your claude.ai connectors (Gmail, Calendar, Drive… once authorized on claude.ai)
     ├─ reminder scheduler (every 15s) → Windows notification + mascot speech bubble
     └─ mascot window + chat window + tray icon
```

## Safety defaults

- The server listens on `127.0.0.1` only, checks the `Host` header, and every API call needs a random
  token created at each start, so web pages you visit can't drive Claude Code.
- Claude Code gets only WebSearch and WebFetch as built-in tools: no shell, no file edits. Connector
  tools are blocked until you allow them in the config.

## Config

`%APPDATA%\Sidekick\config.json` (right-click mascot → Open data folder):

| Key | Default | Meaning |
|---|---|---|
| `effort` | `"low"` | Claude Code effort level (`low` is snappy; `medium`/`high` think harder) |
| `model` | `null` | Model override, e.g. `"sonnet"`; `null` uses your Claude Code default |
| `extraAllowedTools` | `[]` | Extra tools Claude may use without asking |
| `dailySyncTime` | `"08:30"` | Daily sync time (local, HH:MM), or `null` to turn it off |
| `youtubeChannels` | `[]` | Channels to watch (`@handle`, URL or channel id) |

Restart Sidekick (right-click → Quit, then open it from the Start menu) after editing.

## Develop

```bash
npm install
npm start          # run from source
npm run server     # just the local server; open the printed URL in any browser
npm run dist       # build the installer into dist/
```

| File | Role |
|---|---|
| `src/main.js` | Electron shell: mascot + chat windows, tray, shortcut, notifications, launch at login |
| `src/server.js` | Local HTTP server + live event stream + reminder scheduler |
| `src/claude.js` | Runs and talks to the Claude Code CLI (`stream-json` mode) |
| `src/mcp-sidekick.js` | MCP tool server Claude Code launches: reminders, tasks, GitHub, YouTube |
| `src/tasks.js` | Task board storage |
| `src/integrations.js` | GitHub (via `gh`) and YouTube (RSS) readers |
| `src/reminders.js` | Reminder storage shared by the two above |
| `renderer/mascot.*` | The desktop mascot (SVG + CSS animations, moods) |
| `renderer/index.html`, `app.js` | Chat UI, works in the app and in a browser tab |

## Roadmap

- [ ] Smarter heartbeat: nudge during the day only when something urgent arrives
- [ ] Approve or deny tool use from the chat instead of a config file
- [ ] Telegram channel to message it from your phone
- [ ] More mascot moods and outfits
