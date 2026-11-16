//! Read-only integrations that need no extra tokens:
//!  - GitHub through the user's own `gh` CLI login
//!  - YouTube through public channel RSS feeds
//! (Gmail and Calendar come from claude.ai connectors inside Claude Code itself.)

use crate::files::{read_json, write_json};
use crate::proc;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

// ---------- GitHub ----------
async fn gh(args: &[&str]) -> Result<Value, String> {
    let r = proc::run("gh", args, 20, None).await;
    if r.missing {
        return Err("not recognized".into());
    }
    if !r.ok {
        return Err(r.stderr.trim().lines().next().unwrap_or("gh failed").to_string());
    }
    serde_json::from_str(if r.stdout.trim().is_empty() { "null" } else { &r.stdout }).map_err(|_| "unexpected gh output".to_string())
}

fn slim(items: &Value) -> Value {
    Value::Array(
        items
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|i| {
                        json!({
                            "title": i["title"], "repo": i["repository"]["nameWithOwner"],
                            "url": i["url"], "updated": i["updatedAt"]
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub async fn github_inbox() -> Result<Value, String> {
    let f = ["--state=open", "--json", "title,url,repository,updatedAt", "--limit", "15"];
    let with = |base: &[&'static str]| -> Vec<&'static str> { base.iter().chain(f.iter()).copied().collect() };
    let (a_review, a_assigned, a_mine) = (
        with(&["search", "prs", "--review-requested=@me"]),
        with(&["search", "issues", "--assignee=@me"]),
        with(&["search", "prs", "--author=@me"]),
    );
    let (review, assigned, mine, notif) = tokio::join!(gh(&a_review), gh(&a_assigned), gh(&a_mine), gh(&["api", "notifications?per_page=20"]),);
    for r in [&review, &assigned, &mine] {
        if let Err(e) = r {
            if Regex::new("(?i)auth|login").unwrap().is_match(e) {
                return Err("GitHub CLI isn't signed in. Run `gh auth login` in a terminal.".into());
            }
            if e.contains("not recognized") || e.contains("ENOENT") {
                return Err("GitHub CLI (gh) isn't installed.".into());
            }
        }
    }
    let notifications: Vec<Value> = notif
        .unwrap_or(Value::Null)
        .as_array()
        .map(|a| {
            a.iter()
                .map(|n| {
                    let url = n["subject"]["url"].as_str().unwrap_or("").replace("api.github.com/repos", "github.com").replace("/pulls/", "/pull/");
                    json!({
                        "reason": n["reason"], "title": n["subject"]["title"], "type": n["subject"]["type"],
                        "repo": n["repository"]["full_name"], "url": url
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "reviewRequested": slim(&review.unwrap_or(Value::Null)),
        "assignedIssues": slim(&assigned.unwrap_or(Value::Null)),
        "myOpenPRs": slim(&mine.unwrap_or(Value::Null)),
        "unreadNotifications": notifications,
    }))
}

// ---------- YouTube ----------
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sidekick/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("http client")
});

fn decode(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

fn cache_file(dir: &Path) -> std::path::PathBuf {
    dir.join("youtube-ids.json")
}

/// "@handle", a channel URL, or a UC... id → channel id (cached).
pub async fn resolve_channel(dir: &Path, input: &str) -> Result<String, String> {
    static DIRECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(UC[\w-]{22})").unwrap());
    static CANON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})""#).unwrap());
    static EXTERNAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""externalId":"(UC[\w-]{22})""#).unwrap());
    static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<meta itemprop="identifier" content="(UC[\w-]{22})""#).unwrap());
    let raw = input.trim();
    if let Some(m) = DIRECT.captures(raw) {
        return Ok(m[1].to_string());
    }
    let path = raw.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.").trim_start_matches("youtube.com/");
    let handle = format!("@{}", path.trim_start_matches('@').split(['/', '?']).next().unwrap_or(""));
    let cache: BTreeMap<String, String> = read_json(&cache_file(dir)).unwrap_or_default();
    if let Some(id) = cache.get(&handle) {
        return Ok(id.clone());
    }
    let res = HTTP.get(format!("https://www.youtube.com/{handle}")).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("YouTube channel {handle} not found"));
    }
    let html = res.text().await.map_err(|e| e.to_string())?;
    // The page's own channel: canonical link or externalId. (A plain "channelId" can
    // belong to a related channel shown on the page.)
    let id = [&*CANON, &*EXTERNAL, &*META]
        .iter()
        .find_map(|re| re.captures(&html).map(|c| c[1].to_string()))
        .ok_or_else(|| format!("Couldn't find the channel id for {handle}"))?;
    // Re-read before writing: several channels may resolve at the same time.
    let mut latest: BTreeMap<String, String> = read_json(&cache_file(dir)).unwrap_or_default();
    latest.insert(handle, id.clone());
    let _ = write_json(&cache_file(dir), &latest);
    Ok(id)
}

async fn channel_videos(dir: &Path, input: &str, since_days: f64) -> Result<Vec<Value>, String> {
    static ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<entry>(.*?)</entry>").unwrap());
    static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<title>([^<]*)</title>").unwrap());
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<link rel="alternate" href="([^"]+)""#).unwrap());
    static PUBLISHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<published>([^<]+)</published>").unwrap());
    let id = resolve_channel(dir, input).await?;
    let res = HTTP.get(format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}")).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("feed for {input} failed ({})", res.status().as_u16()));
    }
    let xml = res.text().await.map_err(|e| e.to_string())?;
    let channel = TITLE.captures(&xml).map(|c| decode(&c[1])).unwrap_or_else(|| input.to_string());
    let cutoff = chrono::Utc::now().timestamp_millis() - (since_days * 86_400_000.0) as i64;
    Ok(ENTRY
        .captures_iter(&xml)
        .filter_map(|e| {
            let e = &e[1];
            let published = PUBLISHED.captures(e).map(|c| c[1].to_string()).unwrap_or_default();
            let at = crate::files::parse_ms(&published)?;
            (at >= cutoff).then(|| {
                json!({
                    "channel": channel,
                    "title": TITLE.captures(e).map(|c| decode(&c[1])).unwrap_or_default(),
                    "url": LINK.captures(e).map(|c| c[1].to_string()).unwrap_or_default(),
                    "published": published,
                })
            })
        })
        .collect())
}

pub async fn youtube_latest(dir: &Path, channels: &[String], since_days: f64) -> Value {
    if channels.is_empty() {
        return json!({ "videos": [], "note": "No channels followed yet. Use youtube_follow." });
    }
    let futures = channels.iter().map(|c| channel_videos(dir, c, since_days));
    let results = futures_join(futures).await;
    let mut videos = vec![];
    let mut errors = vec![];
    for (c, r) in channels.iter().zip(results) {
        match r {
            Ok(v) => videos.extend(v),
            Err(e) => errors.push(Value::String(format!("{c}: {e}"))),
        }
    }
    let mut out = Map::new();
    out.insert("videos".into(), Value::Array(videos));
    out.insert("errors".into(), Value::Array(errors));
    Value::Object(out)
}

/// Run futures concurrently and collect their results in order.
async fn futures_join<F: std::future::Future>(futs: impl Iterator<Item = F>) -> Vec<F::Output> {
    let handles: Vec<_> = futs.map(Box::pin).collect();
    let mut out = Vec::with_capacity(handles.len());
    // Poll all of them together.
    let mut pending: Vec<Option<std::pin::Pin<Box<F>>>> = handles.into_iter().map(Some).collect();
    let mut results: Vec<Option<F::Output>> = (0..pending.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut all_done = true;
        for (i, slot) in pending.iter_mut().enumerate() {
            if let Some(f) = slot {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => {
                        results[i] = Some(v);
                        *slot = None;
                    }
                    std::task::Poll::Pending => all_done = false,
                }
            }
        }
        if all_done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    out.extend(results.into_iter().map(|r| r.expect("future finished")));
    out
}
