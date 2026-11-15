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

## What starts at login

```
Windows login
 └─ Sidekick.exe
     ├─ local server  127.0.0.1:47821  (UI, chat stream, reminders; token-protected)
     │    └─ claude -p  (your Claude Code login, one long-lived session)
     │         ├─ sidekick MCP server  → create / list / delete reminders
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
| `extraAllowedTools` | `[]` | Extra tools Claude may use without asking, e.g. `["mcp__claude_ai_Gmail"]` |

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
| `src/mcp-reminders.js` | MCP tool server that Claude Code launches for reminders |
| `src/reminders.js` | Reminder storage shared by the two above |
| `renderer/mascot.*` | The desktop mascot (SVG + CSS animations, moods) |
| `renderer/index.html`, `app.js` | Chat UI, works in the app and in a browser tab |

## Roadmap

- [ ] Heartbeat: every N minutes Claude checks new mail and events and nudges you only when it matters
- [ ] Approve or deny tool use from the chat instead of a config file
- [ ] Telegram channel to message it from your phone
- [ ] More mascot moods and outfits
