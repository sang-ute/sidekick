// Task board storage, shared by the local server (UI) and the MCP server (Claude).
// Item: { id, title, notes, source, link, due, done, createdAt, doneAt }
const fs = require("fs");
const path = require("path");

const SOURCES = ["me", "gmail", "github", "youtube", "calendar", "other"];
const fileIn = (dataDir) => path.join(dataDir, "tasks.json");

function load(dataDir) {
  try { return JSON.parse(fs.readFileSync(fileIn(dataDir), "utf8")); } catch { return []; }
}

function save(dataDir, list) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${fileIn(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, fileIn(dataDir));
}

function add(dataDir, { title, notes = "", source = "me", link = "", due = null }) {
  const list = load(dataDir);
  // Same link already on the board and not done? Don't add it twice (syncs run daily).
  if (link) {
    const dup = list.find((t) => t.link === link && !t.done);
    if (dup) return { task: dup, duplicate: true };
  }
  const task = {
    id: Math.random().toString(36).slice(2, 8),
    title: String(title).slice(0, 200),
    notes: String(notes || "").slice(0, 500),
    source: SOURCES.includes(source) ? source : "other",
    link: /^https?:\/\//.test(link || "") ? link : "",
    due: due && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  list.push(task);
  save(dataDir, list);
  return { task, duplicate: false };
}

function update(dataDir, id, patch) {
  const list = load(dataDir);
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  if (typeof patch.done === "boolean") {
    t.done = patch.done;
    t.doneAt = patch.done ? new Date().toISOString() : null;
  }
  if (typeof patch.title === "string" && patch.title.trim()) t.title = patch.title.trim().slice(0, 200);
  save(dataDir, list);
  return t;
}

function remove(dataDir, id) {
  const list = load(dataDir);
  const next = list.filter((t) => t.id !== id);
  save(dataDir, next);
  return next.length !== list.length;
}

/** Drop finished tasks older than a week so the board stays small. */
function prune(dataDir) {
  const cutoff = Date.now() - 7 * 864e5;
  const list = load(dataDir);
  const next = list.filter((t) => !t.done || new Date(t.doneAt).getTime() > cutoff);
  if (next.length !== list.length) save(dataDir, next);
}

module.exports = { SOURCES, load, add, update, remove, prune };
