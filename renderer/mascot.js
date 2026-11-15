// The desktop pet. Listens to the local server's event stream to react to what
// Claude Code is doing, and talks to the Electron shell for dragging and click-through.
const shellApi = window.sidekickShell;
const pet = document.getElementById("pet");
const eyes = pet.querySelector(".eyes");
const speech = document.getElementById("speech");
const speechText = document.getElementById("speechText");

const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
const TOKEN = hashToken || "";

// ---------- mood ----------
const MOODS = ["idle", "thinking", "talking", "happy", "alert", "sad", "sleeping"];
let mood = "idle";
let moodTimer = null;
let lastActivity = Date.now();

function setMood(next, ms) {
  clearTimeout(moodTimer);
  mood = next;
  pet.classList.remove(...MOODS);
  pet.classList.add(next);
  if (next !== "sleeping") lastActivity = Date.now();
  if (ms) moodTimer = setTimeout(() => setMood("idle"), ms);
}

let speechTimer = null;
function say(text, ms = 8000) {
  clearTimeout(speechTimer);
  speechText.textContent = text;
  speech.hidden = false;
  if (ms) speechTimer = setTimeout(() => { speech.hidden = true; }, ms);
}
speech.addEventListener("click", () => { speech.hidden = true; shellApi.openPanel(); if (mood === "alert") setMood("idle"); });

// Idle life: hop now and then, fall asleep after 10 quiet minutes.
setInterval(() => {
  if (mood === "idle" && Date.now() - lastActivity > 10 * 60_000) return setMood("sleeping");
  if (mood === "idle" && Math.random() < 0.35) {
    pet.classList.remove("hop");
    void pet.offsetWidth;
    pet.classList.add("hop");
  }
}, 20_000);
pet.addEventListener("animationend", (e) => { if (e.animationName === "hop") pet.classList.remove("hop"); });

// ---------- eyes follow the cursor (position comes from the main process) ----------
shellApi.onCursor(({ dx, dy }) => {
  if (mood === "sleeping") {
    if (Math.hypot(dx, dy) < 120) setMood("idle"); // wake up when you come close
    return;
  }
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 300);
  const x = (dx / d) * 4 * k;
  const y = (dy / d) * 3 * k - (mood === "thinking" ? 3 : 0);
  eyes.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
});

// ---------- click-through outside the pet ----------
// The window is bigger than the pet (room for the speech bubble). Transparent parts
// pass clicks to the desktop; only the pet and the bubble catch the mouse.
let dragging = false;
for (const el of [pet, speech]) {
  el.addEventListener("mouseenter", () => shellApi.setInteractive(true));
  el.addEventListener("mouseleave", () => { if (!dragging) shellApi.setInteractive(false); });
}

// ---------- drag to move, click to open chat ----------
let start = null;
pet.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  start = { x: e.screenX, y: e.screenY, moved: false };
  pet.setPointerCapture(e.pointerId);
  shellApi.dragStart();
});
pet.addEventListener("pointermove", (e) => {
  if (!start) return;
  const dx = e.screenX - start.x;
  const dy = e.screenY - start.y;
  if (!start.moved && Math.hypot(dx, dy) < 5) return;
  start.moved = true;
  dragging = true;
  pet.classList.add("dragging");
  shellApi.dragMove(dx, dy);
});
pet.addEventListener("pointerup", (e) => {
  if (!start) return;
  const wasDrag = start.moved;
  start = null;
  dragging = false;
  pet.classList.remove("dragging");
  pet.releasePointerCapture(e.pointerId);
  shellApi.dragEnd();
  if (!wasDrag) {
    if (mood === "sleeping" || mood === "alert") setMood("idle");
    speech.hidden = true;
    shellApi.togglePanel();
  }
});
pet.addEventListener("contextmenu", (e) => { e.preventDefault(); shellApi.showMenu(); });

// ---------- react to Claude Code ----------
let panelOpen = false;
shellApi.onPanel((open) => { panelOpen = open; if (open) speech.hidden = true; });

let replyPreview = "";
function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener("hello", (e) => {
    const { status } = JSON.parse(e.data);
    if (status.state === "missing") { setMood("sad"); say("I can't find Claude Code. Is it installed and signed in?", 0); }
  });
  es.addEventListener("user", () => { replyPreview = ""; setMood("thinking"); });
  es.addEventListener("tool", () => setMood("thinking"));
  es.addEventListener("delta", (e) => {
    replyPreview += JSON.parse(e.data);
    if (mood !== "talking") setMood("talking");
  });
  es.addEventListener("done", () => {
    setMood("happy", 1500);
    // If the chat is closed, show the start of the answer in a speech bubble.
    const text = replyPreview.trim();
    if (!panelOpen && text) say(text.length > 140 ? text.slice(0, 137) + "…" : text, 10000);
  });
  es.addEventListener("failure", () => {
    setMood("sad", 4000);
    if (!panelOpen) say("Something went wrong. Click me for details.");
  });
  es.addEventListener("reminder", (e) => {
    const r = JSON.parse(e.data);
    setMood("alert", 15000);
    say(`⏰ ${r.text}`, 30000);
  });
  es.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    if (s.state === "missing") setMood("sad");
  });
}
connect();
setTimeout(() => say("Hi! Click me to chat. Drag me anywhere. 👋", 6000), 800);
