# Sidekick

A small floating assistant for Windows that runs on **your own Claude Code login** (Pro/Max plan).
No API key. It starts with Windows, sits as a bubble in the corner, chats, searches the web, uses
your claude.ai connectors, and reminds you of things with desktop notifications.

## Run it

Requirements: Node 18+, and Claude Code installed and signed in (`claude` in a terminal once).

```bash
npm install
npm start          # desktop bubble + local server
npm run server     # just the local server; open the printed URL in any browser
```

- **Ctrl+Shift+Space** toggles the panel; **Esc** collapses it; drag the panel by its header.
- Tray icon (right-click): open in browser, start with Windows, open data folder, quit.
- Try: *"remind me in 2 minutes to drink water"*, *"every weekday at 9 remind me to check job boards"*.

## What starts at login

```
Windows login
 └─ Sidekick (Electron)
     ├─ local server  127.0.0.1:47821  (UI, chat stream, reminders; token-protected)
     │    └─ claude -p  (your Claude Code login, one long-lived session)
     │         ├─ sidekick MCP server  → create / list / delete reminders
     │         ├─ WebSearch, WebFetch
     │         └─ your claude.ai connectors (Gmail, Calendar, Drive… once authorized on claude.ai)
     ├─ reminder scheduler (every 15s) → Windows notification
     └─ bubble window + tray
```

## Safety defaults

- The server listens on `127.0.0.1` only, checks the `Host` header, and every API call needs a random
  token created at each boot, so web pages you visit can't drive Claude Code.
- Claude Code gets only WebSearch and WebFetch as built-in tools: no shell, no file edits. Connector
  tools are blocked until you allow them.

## Config

`%APPDATA%\sidekick\config.json`:

| Key | Default | Meaning |
|---|---|---|
| `effort` | `"low"` | Claude Code effort level (`low` is snappy; `medium`/`high` think harder) |
| `model` | `null` | Model override, e.g. `"sonnet"`; `null` uses your Claude Code default |
| `extraAllowedTools` | `[]` | Extra tools Claude may use without asking, e.g. `["mcp__claude_ai_Gmail"]` |

Restart Sidekick (tray → Quit, then start it again) after editing.

## Files

| File | Role |
|---|---|
| `src/main.js` | Electron shell: bubble, tray, shortcut, notifications, launch at login |
| `src/server.js` | Local HTTP server + SSE stream + reminder scheduler |
| `src/claude.js` | Runs and talks to the Claude Code CLI (`stream-json` mode) |
| `src/mcp-reminders.js` | MCP tool server Claude Code launches for reminders |
| `src/reminders.js` | Reminder storage shared by the two above |
| `renderer/` | UI, works in the bubble and in a browser tab |

## Roadmap

- [ ] Heartbeat: every N minutes Claude checks new mail and events and nudges you only when it matters
- [ ] Approve or deny tool use from the panel instead of a config file
- [ ] Telegram channel to message it from your phone
- [ ] Installer (`electron-builder`) so autostart doesn't depend on the source folder
