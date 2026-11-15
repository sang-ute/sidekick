// Reminder storage shared by the local server (which fires them) and the MCP
// tool server (which Claude Code calls to create them). Plain fs, no Electron.
// Item: { id, text, dueAt (ISO), repeat: "none"|"daily"|"weekly", createdAt }
const fs = require("fs");
const path = require("path");

function fileIn(dataDir) {
  return path.join(dataDir, "reminders.json");
}

function load(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8"));
  } catch {
    return [];
  }
}

function save(dataDir, list) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${fileIn(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, fileIn(dataDir)); // atomic replace: two processes write this file
}

function add(dataDir, { text, dueAt, repeat = "none" }) {
  const list = load(dataDir);
  const r = {
    id: Math.random().toString(36).slice(2, 8),
    text,
    dueAt: new Date(dueAt).toISOString(),
    repeat,
    createdAt: new Date().toISOString(),
  };
  list.push(r);
  save(dataDir, list);
  return r;
}

function remove(dataDir, id) {
  const list = load(dataDir);
  const next = list.filter((r) => r.id !== id);
  save(dataDir, next);
  return next.length !== list.length;
}

function nextOccurrence(r, now) {
  const step = r.repeat === "daily" ? 864e5 : 7 * 864e5;
  let t = new Date(r.dueAt).getTime();
  while (t <= now) t += step; // skip occurrences missed while the PC was off
  return new Date(t).toISOString();
}

/** Returns reminders that are due now and reschedules or removes them. */
function takeDue(dataDir, now = Date.now()) {
  const list = load(dataDir);
  const due = [];
  const keep = [];
  for (const r of list) {
    if (new Date(r.dueAt).getTime() > now) { keep.push(r); continue; }
    due.push(r);
    if (r.repeat === "daily" || r.repeat === "weekly") keep.push({ ...r, dueAt: nextOccurrence(r, now) });
  }
  if (due.length) save(dataDir, keep);
  return due;
}

module.exports = { load, add, remove, takeDue };
