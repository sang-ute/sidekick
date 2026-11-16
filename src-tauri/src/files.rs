//! Data folder location and small JSON-file helpers (shared with the MCP mode).

use serde::{de::DeserializeOwned, Serialize};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// `%APPDATA%\sidekick`, the same folder Sidekick 0.x used, so tasks, reminders and
/// settings carry over. `SIDEKICK_DATA` overrides it (tests, screenshots, MCP mode).
pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("SIDEKICK_DATA") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        Path::new(&home).join(".config")
    });
    base.join("sidekick")
}

/// Test runs (separate data folder, screenshots) never start a real sync on their own.
pub fn is_test_run() -> bool {
    std::env::var("SIDEKICK_TEST").map(|v| !v.is_empty()).unwrap_or(false)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write via a temp file + rename, so a crash or the other process never sees half a file.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, data: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), random_u64() % 100_000));
    std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
    std::fs::rename(&tmp, path)
}

fn random_u64() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// Short random id, e.g. "k3x9qa" (base 36).
pub fn new_id(len: usize) -> String {
    const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = random_u64();
    (0..len)
        .map(|_| {
            if n == 0 {
                n = random_u64();
            }
            let c = ALPHA[(n % 36) as usize] as char;
            n /= 36;
            c
        })
        .collect()
}

/// 8 hex characters, used for notification ids.
pub fn hex_id() -> String {
    format!("{:08x}", random_u64() as u32)
}

/// Current time as an ISO string like JavaScript's `toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Parse any RFC 3339 / ISO time (with offset) into UTC milliseconds.
pub fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis())
}

pub fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
