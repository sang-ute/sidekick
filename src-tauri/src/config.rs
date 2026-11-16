//! Sidekick settings: defaults, choices shown in the settings window, and validation.
//! Stored in `<data dir>/config.json`, same format as Sidekick 0.x so settings carry over.

use crate::files::{read_json, write_json};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Integrations {
    pub github: bool,
    pub youtube: bool,
    pub gmail: bool,
    pub calendar: bool,
    pub web: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServer {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notifier {
    pub auto_show: bool,
    pub hide_after_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub model: Option<String>,
    pub effort: String,
    pub response_style: String,
    pub language: String,
    pub integrations: Integrations,
    pub mcp_servers: BTreeMap<String, McpServer>,
    pub extra_allowed_tools: Vec<String>,
    pub youtube_channels: Vec<String>,
    pub daily_sync_time: Option<String>,
    pub theme: String,
    pub open_at_login: bool,
    pub mascot_visible: bool,
    pub mascot_size: String,
    pub sleep_after_minutes: u32,
    pub notifier: Notifier,
    pub shortcut: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            model: None,
            effort: "low".into(),
            response_style: "balanced".into(),
            language: String::new(),
            integrations: Integrations { github: true, youtube: true, gmail: true, calendar: true, web: true },
            mcp_servers: BTreeMap::new(),
            extra_allowed_tools: vec![],
            youtube_channels: vec![],
            daily_sync_time: Some("08:30".into()),
            theme: "system".into(),
            open_at_login: true,
            mascot_visible: true,
            mascot_size: "medium".into(),
            sleep_after_minutes: 10,
            notifier: Notifier { auto_show: true, hide_after_seconds: 12 },
            shortcut: "Control+Shift+Space".into(),
        }
    }
}

pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
pub const STYLES: [&str; 3] = ["brief", "balanced", "detailed"];
pub const THEMES: [&str; 3] = ["system", "light", "dark"];
pub const SIZES: [&str; 3] = ["small", "medium", "large"];

/// Choices shown in the settings window.
pub fn options() -> Value {
    json!({
        "models": [
            { "id": null, "label": "Default", "note": "Whatever Claude Code is set to use" },
            { "id": "claude-opus-5-5", "label": "Claude Opus 5.5", "note": "Smart all-rounder" },
            { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "note": "Fast and capable" },
            { "id": "claude-haiku-5-5", "label": "Claude Haiku 5.5", "note": "Fastest, lightest on usage" },
            { "id": "claude-fable-5-2", "label": "Claude Fable 5.2", "note": "Most capable, heaviest on usage; may need a higher plan" }
        ],
        "efforts": [
            { "id": "low", "label": "Low", "hint": "Quick answers, lightest on usage" },
            { "id": "medium", "label": "Medium", "hint": "A bit more thought" },
            { "id": "high", "label": "High", "hint": "Thinks things through" },
            { "id": "xhigh", "label": "Extra high", "hint": "Deep reasoning, slower" },
            { "id": "max", "label": "Max", "hint": "Maximum effort, slowest and heaviest" }
        ],
        "responseStyles": [
            { "id": "brief", "label": "Brief", "hint": "One to three short lines" },
            { "id": "balanced", "label": "Balanced", "hint": "Short, with detail when it helps" },
            { "id": "detailed", "label": "Detailed", "hint": "Full explanations and steps" }
        ],
        "themes": THEMES,
        "mascotSizes": SIZES,
    })
}

impl Config {
    /// Settings whose change restarts the Claude Code session.
    pub fn ai_differs(&self, other: &Config) -> bool {
        self.model != other.model
            || self.effort != other.effort
            || self.response_style != other.response_style
            || self.language != other.language
            || self.integrations != other.integrations
            || self.mcp_servers != other.mcp_servers
            || self.extra_allowed_tools != other.extra_allowed_tools
    }

    pub fn mascot_scale(&self) -> f64 {
        match self.mascot_size.as_str() {
            "small" => 0.8,
            "large" => 1.25,
            _ => 1.0,
        }
    }
}

fn file(dir: &Path) -> std::path::PathBuf {
    dir.join("config.json")
}

/// Load settings, filling anything missing or invalid with defaults (key by key, so one
/// bad value doesn't reset everything).
pub fn load(dir: &Path) -> Config {
    let mut cfg = Config::default();
    if let Some(Value::Object(obj)) = read_json::<Value>(&file(dir)) {
        for (k, v) in obj {
            let mut one = Map::new();
            one.insert(k, v);
            if let Ok(clean) = validate_patch(&Value::Object(one), &cfg) {
                cfg = clean;
            }
        }
    }
    cfg
}

pub fn save(dir: &Path, cfg: &Config) {
    let _ = write_json(&file(dir), cfg);
}

// ---------- validation ----------
macro_rules! re {
    ($s:expr) => {{
        static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($s).unwrap());
        &*R
    }};
}

fn one_of(v: &Value, list: &[&str], name: &str) -> Result<String, String> {
    match v.as_str() {
        Some(s) if list.contains(&s) => Ok(s.to_string()),
        _ => Err(format!("{name} must be one of: {}", list.join(", "))),
    }
}
fn boolean(v: &Value, name: &str) -> Result<bool, String> {
    v.as_bool().ok_or_else(|| format!("{name} must be true or false"))
}
fn int(v: &Value, min: u64, max: u64, name: &str) -> Result<u32, String> {
    match v.as_u64() {
        Some(n) if n >= min && n <= max => Ok(n as u32),
        _ => Err(format!("{name} must be a whole number from {min} to {max}")),
    }
}
fn str_list(v: &Value, name: &str, re: &Regex) -> Result<Vec<String>, String> {
    let arr = v.as_array().filter(|a| a.len() <= 50).ok_or_else(|| format!("{name} must be a list of up to 50 items"))?;
    let mut out: Vec<String> = vec![];
    for s in arr {
        let t = s.as_str().map(str::trim).unwrap_or("");
        if !re.is_match(t) {
            let shown: String = s.as_str().unwrap_or("").chars().take(40).collect();
            return Err(format!("{name}: \"{shown}\" isn't allowed"));
        }
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}
fn str_map(v: Option<&Value>, name: &str, key_re: &Regex) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let Some(v) = v else { return Ok(out) };
    if v.is_null() {
        return Ok(out);
    }
    let obj = v.as_object().ok_or_else(|| format!("{name} must be KEY=VALUE pairs"))?;
    for (k, val) in obj {
        match val.as_str() {
            Some(s) if key_re.is_match(k) && s.len() <= 2000 => {
                out.insert(k.clone(), s.to_string());
            }
            _ => return Err(format!("{name}: bad entry \"{k}\"")),
        }
    }
    Ok(out)
}

fn mcp_servers(v: &Value) -> Result<BTreeMap<String, McpServer>, String> {
    let obj = v.as_object().ok_or("mcpServers must be an object")?;
    if obj.len() > 20 {
        return Err("At most 20 custom MCP servers".into());
    }
    let mut out = BTreeMap::new();
    for (name, s) in obj {
        if !re!(r"^[A-Za-z0-9_-]{1,40}$").is_match(name) {
            return Err(format!("MCP server name \"{name}\" can only use letters, numbers, - and _"));
        }
        if name.eq_ignore_ascii_case("sidekick") {
            return Err("\"sidekick\" is reserved for the built-in tools".into());
        }
        let s = s.as_object().ok_or_else(|| format!("MCP server \"{name}\" is invalid"))?;
        let server = match s.get("type").and_then(Value::as_str) {
            Some("http") => {
                let url = s.get("url").and_then(Value::as_str).unwrap_or("");
                if !re!(r"^https?://\S{3,500}$").is_match(url) {
                    return Err(format!("MCP server \"{name}\" needs an http(s) URL"));
                }
                McpServer::Http {
                    url: url.to_string(),
                    headers: str_map(s.get("headers"), &format!("{name} headers"), re!(r"^[A-Za-z0-9-]{1,80}$"))?,
                }
            }
            Some("stdio") | None => {
                let command = s.get("command").and_then(Value::as_str).unwrap_or("").trim();
                if command.is_empty() || command.len() > 300 {
                    return Err(format!("MCP server \"{name}\" needs a command"));
                }
                let args = match s.get("args") {
                    None | Some(Value::Null) => vec![],
                    Some(Value::Array(a)) if a.len() <= 50 && a.iter().all(|x| x.as_str().is_some_and(|t| t.len() <= 500)) => {
                        a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
                    }
                    _ => return Err(format!("MCP server \"{name}\" has invalid arguments")),
                };
                McpServer::Stdio {
                    command: command.to_string(),
                    args,
                    env: str_map(s.get("env"), &format!("{name} env"), re!(r"^[A-Za-z_][A-Za-z0-9_]{0,80}$"))?,
                }
            }
            _ => return Err(format!("MCP server \"{name}\": type must be stdio or http")),
        };
        out.insert(name.clone(), server);
    }
    Ok(out)
}

/// Apply a partial settings object on top of `current`, validating every key.
/// Returns the new full config, or a readable error message.
pub fn validate_patch(patch: &Value, current: &Config) -> Result<Config, String> {
    let obj = patch.as_object().ok_or("Settings must be an object")?;
    let mut c = current.clone();
    for (key, v) in obj {
        match key.as_str() {
            "model" => {
                c.model = match v {
                    Value::Null => None,
                    Value::String(s) if s.is_empty() => None,
                    Value::String(s) if re!(r"^[A-Za-z0-9.\-\[\]]{2,60}$").is_match(s) => Some(s.clone()),
                    _ => return Err("model is not a valid model name".into()),
                }
            }
            "effort" => c.effort = one_of(v, &EFFORTS, "effort")?,
            "responseStyle" => c.response_style = one_of(v, &STYLES, "responseStyle")?,
            "language" => match v.as_str() {
                Some(s) if re!(r"^[\p{L} ()'-]{0,40}$").is_match(s) => c.language = s.trim().to_string(),
                _ => return Err("language should be a language name, like Vietnamese".into()),
            },
            "integrations" => {
                let o = v.as_object().ok_or("integrations must be an object")?;
                let i = &mut c.integrations;
                for (k, val) in o {
                    let b = boolean(val, &format!("integrations.{k}"))?;
                    match k.as_str() {
                        "github" => i.github = b,
                        "youtube" => i.youtube = b,
                        "gmail" => i.gmail = b,
                        "calendar" => i.calendar = b,
                        "web" => i.web = b,
                        _ => {}
                    }
                }
            }
            "mcpServers" => c.mcp_servers = mcp_servers(v)?,
            "extraAllowedTools" => c.extra_allowed_tools = str_list(v, "extraAllowedTools", re!(r"^[A-Za-z0-9_*().:\- ]{1,100}$"))?,
            "youtubeChannels" => c.youtube_channels = str_list(v, "youtubeChannels", re!(r#"^[^\s"'<>]{2,100}$"#))?,
            "dailySyncTime" => {
                c.daily_sync_time = match v {
                    Value::Null => None,
                    Value::String(s) if s.is_empty() => None,
                    Value::String(s) if re!(r"^([01]\d|2[0-3]):[0-5]\d$").is_match(s) => Some(s.clone()),
                    _ => return Err("dailySyncTime must look like 08:30".into()),
                }
            }
            "theme" => c.theme = one_of(v, &THEMES, "theme")?,
            "openAtLogin" => c.open_at_login = boolean(v, key)?,
            "mascotVisible" => c.mascot_visible = boolean(v, key)?,
            "mascotSize" => c.mascot_size = one_of(v, &SIZES, "mascotSize")?,
            "sleepAfterMinutes" => c.sleep_after_minutes = int(v, 0, 240, "sleepAfterMinutes")?,
            "notifier" => {
                let o = v.as_object().ok_or("notifier must be an object")?;
                if let Some(a) = o.get("autoShow") {
                    c.notifier.auto_show = boolean(a, "notifier.autoShow")?;
                }
                if let Some(h) = o.get("hideAfterSeconds") {
                    c.notifier.hide_after_seconds = int(h, 3, 120, "notifier.hideAfterSeconds")?;
                }
            }
            "shortcut" => {
                let parts: Vec<&str> = v.as_str().unwrap_or("").split('+').map(str::trim).collect();
                let part_re = re!(r"(?i)^(Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|Shift|Super|Meta|[A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Escape|Esc)$");
                if parts.len() < 2 || parts.len() > 4 || !parts.iter().all(|p| part_re.is_match(p)) {
                    return Err("shortcut should look like \"Control+Shift+Space\"".into());
                }
                c.shortcut = parts.join("+");
            }
            other => return Err(format!("Unknown setting \"{other}\"")),
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_reserved_and_bad_values() {
        let c = Config::default();
        assert!(validate_patch(&json!({"mcpServers": {"sidekick": {"command": "x"}}}), &c).unwrap_err().contains("reserved"));
        assert!(validate_patch(&json!({"shortcut": "banana"}), &c).is_err());
        assert!(validate_patch(&json!({"nope": 1}), &c).unwrap_err().contains("Unknown"));
        assert!(validate_patch(&json!({"sleepAfterMinutes": 1.5}), &c).is_err());
        assert!(validate_patch(&json!({"dailySyncTime": "25:00"}), &c).is_err());
    }

    #[test]
    fn applies_partial_nested_values() {
        let c = Config::default();
        let n = validate_patch(&json!({"notifier": {"hideAfterSeconds": 20}, "integrations": {"web": false}}), &c).unwrap();
        assert_eq!(n.notifier.hide_after_seconds, 20);
        assert!(n.notifier.auto_show);
        assert!(!n.integrations.web && n.integrations.github);
        let m = validate_patch(&json!({"mcpServers": {"fs": {"type": "stdio", "command": "npx", "args": ["-y", "x"]}}}), &c).unwrap();
        assert!(matches!(m.mcp_servers.get("fs"), Some(McpServer::Stdio { .. })));
        let s = validate_patch(&json!({"shortcut": "ctrl + shift + k"}), &c).unwrap();
        assert_eq!(s.shortcut, "ctrl+shift+k");
    }

    #[test]
    fn json_keeps_the_0x_shape() {
        let v = serde_json::to_value(Config::default()).unwrap();
        assert_eq!(v["dailySyncTime"], "08:30");
        assert_eq!(v["notifier"]["hideAfterSeconds"], 12);
        assert!(v["model"].is_null());
        let back: Config = serde_json::from_value(v).unwrap();
        assert_eq!(back, Config::default());
    }

    #[test]
    fn load_keeps_good_keys_when_one_is_bad() {
        let dir = std::env::temp_dir().join(format!("sidekick-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"theme":"dark","effort":"nonsense","youtubeChannels":["@a"]}"#).unwrap();
        let c = load(&dir);
        assert_eq!(c.theme, "dark");
        assert_eq!(c.effort, "low");
        assert_eq!(c.youtube_channels, vec!["@a"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
