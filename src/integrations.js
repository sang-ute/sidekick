// Read-only integrations that need no extra tokens:
//  - GitHub through the user's own `gh` CLI login
//  - YouTube through public channel RSS feeds
// (Gmail and Calendar come from claude.ai connectors inside Claude Code itself.)
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- GitHub ----------
function gh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: (stderr || err.message).trim().split("\n")[0] });
      try { resolve({ data: JSON.parse(stdout || "null") }); } catch { resolve({ error: "unexpected gh output" }); }
    });
  });
}

const slim = (items) =>
  (items || []).map((i) => ({
    title: i.title,
    repo: i.repository?.nameWithOwner,
    url: i.url,
    updated: i.updatedAt,
  }));

async function githubInbox() {
  const fields = ["--state=open", "--json", "title,url,repository,updatedAt", "--limit", "15"];
  const [review, assigned, mine, notif] = await Promise.all([
    gh(["search", "prs", "--review-requested=@me", ...fields]),
    gh(["search", "issues", "--assignee=@me", ...fields]),
    gh(["search", "prs", "--author=@me", ...fields]),
    gh(["api", "notifications?per_page=20"]),
  ]);
  const firstErr = [review, assigned, mine].find((r) => r.error);
  if (firstErr && /auth|login/i.test(firstErr.error)) {
    return { error: "GitHub CLI isn't signed in. Run `gh auth login` in a terminal." };
  }
  if (firstErr && /not recognized|ENOENT/i.test(firstErr.error)) {
    return { error: "GitHub CLI (gh) isn't installed." };
  }
  return {
    reviewRequested: slim(review.data),
    assignedIssues: slim(assigned.data),
    myOpenPRs: slim(mine.data),
    unreadNotifications: (notif.data || []).map((n) => ({
      reason: n.reason,
      title: n.subject?.title,
      type: n.subject?.type,
      repo: n.repository?.full_name,
      // API urls → web urls, so the task board link opens in the browser
      url: (n.subject?.url || "").replace("api.github.com/repos", "github.com").replace("/pulls/", "/pull/"),
    })),
  };
}

// ---------- YouTube ----------
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sidekick/0.4" };
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function cacheFile(dataDir) { return path.join(dataDir, "youtube-ids.json"); }

/** "@handle", a channel URL, or a UC... id → channel id (cached). */
async function resolveChannel(dataDir, input) {
  const raw = String(input).trim();
  const direct = raw.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];
  const handle = raw.replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/^@?/, "@").split(/[/?]/)[0];
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile(dataDir), "utf8")); } catch {}
  if (cache[handle]) return cache[handle];
  const res = await fetch(`https://www.youtube.com/${encodeURIComponent(handle)}`, { headers: UA });
  if (!res.ok) throw new Error(`YouTube channel ${handle} not found`);
  const html = await res.text();
  // The page's own channel: canonical link or externalId. (A plain "channelId" can belong
  // to a related channel shown on the page.)
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/);
  if (!m) throw new Error(`Couldn't find the channel id for ${handle}`);
  // Re-read before writing: several channels may resolve at the same time.
  let latest = {};
  try { latest = JSON.parse(fs.readFileSync(cacheFile(dataDir), "utf8")); } catch {}
  fs.writeFileSync(cacheFile(dataDir), JSON.stringify({ ...latest, [handle]: m[1] }, null, 2));
  return m[1];
}

async function channelVideos(dataDir, input, sinceDays) {
  const id = await resolveChannel(dataDir, input);
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { headers: UA });
  if (!res.ok) throw new Error(`feed for ${input} failed (${res.status})`);
  const xml = await res.text();
  const channel = decode((xml.match(/<title>([^<]*)<\/title>/) || [])[1] || input);
  const cutoff = Date.now() - sinceDays * 864e5;
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      channel,
      title: decode((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ""),
      url: (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || "",
      published: (e.match(/<published>([^<]+)<\/published>/) || [])[1] || "",
    }))
    .filter((v) => new Date(v.published).getTime() >= cutoff);
}

async function youtubeLatest(dataDir, channels, sinceDays = 2) {
  if (!channels.length) return { videos: [], note: "No channels followed yet. Use youtube_follow." };
  const results = await Promise.allSettled(channels.map((c) => channelVideos(dataDir, c, sinceDays)));
  return {
    videos: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    errors: results.flatMap((r, i) => (r.status === "rejected" ? [`${channels[i]}: ${r.reason.message}`] : [])),
  };
}

module.exports = { githubInbox, youtubeLatest, resolveChannel };
