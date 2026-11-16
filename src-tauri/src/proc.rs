//! Child processes: finding Claude Code, running CLIs, opening a terminal for sign-ins.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

/// Windows: don't flash a console window for background commands.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Environment markers other programs must not inherit.
const STRIP_ENV: [&str; 3] = ["ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    for k in STRIP_ENV {
        c.env_remove(k);
    }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c.kill_on_drop(true);
    c
}

fn std_command(program: &str) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    for k in STRIP_ENV {
        c.env_remove(k);
    }
    c
}

/// Path to the `claude` CLI, or None when Claude Code isn't installed.
pub fn find_claude() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SIDEKICK_CLAUDE_PATH") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let mut w = std_command("where");
    w.arg("claude");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        w.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(out) = w.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(hit) = text.lines().map(str::trim).find(|l| {
            let l = l.to_ascii_lowercase();
            l.ends_with(".exe") || l.ends_with(".cmd")
        }) {
            return Some(PathBuf::from(hit));
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let fallback = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
    fallback.exists().then_some(fallback)
}

pub struct RunResult {
    pub ok: bool,
    pub missing: bool, // the program itself wasn't found
    pub stdout: String,
    pub stderr: String,
}

/// Run a command and collect its output. Never fails; check `ok`.
pub async fn run(program: impl AsRef<std::ffi::OsStr>, args: &[&str], timeout_s: u64, cwd: Option<&std::path::Path>) -> RunResult {
    let mut c = command(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            return RunResult { ok: false, missing: e.kind() == std::io::ErrorKind::NotFound, stdout: String::new(), stderr: e.to_string() }
        }
    };
    match tokio::time::timeout(Duration::from_secs(timeout_s), child.wait_with_output()).await {
        Ok(Ok(out)) => RunResult {
            ok: out.status.success(),
            missing: false,
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Ok(Err(e)) => RunResult { ok: false, missing: false, stdout: String::new(), stderr: e.to_string() },
        Err(_) => RunResult { ok: false, missing: false, stdout: String::new(), stderr: "timed out".into() },
    }
}

/// Open a visible terminal running a command (for interactive sign-ins). Windows only.
pub fn open_terminal(args: &[&str]) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Opening a terminal is only supported on Windows".into());
    }
    let mut c = std_command("cmd.exe");
    c.args(["/c", "start", "Sidekick sign-in", "cmd.exe", "/k"]).args(args);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}
