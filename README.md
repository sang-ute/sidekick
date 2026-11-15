# Sidekick

A small floating assistant for Windows, powered by Claude. It sits as a bubble in the corner of your screen,
starts with Windows, chats, searches the web, and reminds you of things with desktop notifications.

## Run it

```bash
npm install
npm start
```

On first open, paste an Anthropic API key (console.anthropic.com → API Keys). It's encrypted with
Windows DPAPI and stored in `%APPDATA%\sidekick\settings.json`. Setting `ANTHROPIC_API_KEY` works too.

- **Ctrl+Shift+Space** toggles the panel; **Esc** collapses it.
- Drag the panel by its header. Right-click the tray icon for "Start with Windows", hide/show, and quit.
- Try: *"remind me in 2 minutes to drink water"*, *"every weekday at 9 remind me to check job boards"*,
  *"what's the weather in Ho Chi Minh City?"*

## How it works

| File | Role |
|---|---|
| `src/main.js` | Electron main: bubble window, tray, shortcut, launch at login, reminder scheduler (checks every 15s) |
| `src/agent.js` | Claude tool-use loop (streaming, `claude-opus-5-5`, low effort) with reminder tools and web search |
| `src/store.js` | JSON storage for settings and reminders, encrypted API key |
| `src/preload.js` | The only bridge from the page to the main process |
| `renderer/` | The UI (all text inserted as plain text, never HTML) |

## Cost

You pay per use on the API key. Normal chatting at low effort costs a few cents a day. Reminders fire
locally and cost nothing.

## Roadmap

- [ ] Gmail and Google Calendar (OAuth), with read/draft only and a confirm step before sending
- [ ] Heartbeat: every N minutes a cheap model (Claude Haiku 5.5) checks new mail and events and nudges you only when it matters
- [ ] Long-term memory notes about you
- [ ] Telegram bot channel, so you can text it from your phone
- [ ] Installer (`electron-builder`) so it no longer needs the source folder
