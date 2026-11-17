//! Shared helpers for the integration tests.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// The Sidekick executable cargo built for these tests.
pub const SIDEKICK: &str = env!("CARGO_BIN_EXE_sidekick");

/// Sidekick's MCP server (`sidekick --mcp`) on its own temporary data folder, driven the way
/// Claude Code drives it: newline-delimited JSON-RPC over stdin/stdout.
pub struct Mcp {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next_id: u64,
    pub dir: tempfile::TempDir,
}

impl Mcp {
    /// `disabled` is the SIDEKICK_DISABLED list the app passes, e.g. "github,youtube".
    pub fn start(disabled: &str) -> Mcp {
        Self::start_in(tempfile::tempdir().unwrap(), disabled)
    }

    pub fn start_in(dir: tempfile::TempDir, disabled: &str) -> Mcp {
        let mut child = Command::new(SIDEKICK)
            .arg("--mcp")
            .env("SIDEKICK_DATA", dir.path())
            .env("SIDEKICK_DISABLED", disabled)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start sidekick --mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Mcp { child, stdin, lines, next_id: 0, dir }
    }

    pub fn send_raw(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// The next message from the server (fails the test after 15 s of silence).
    pub fn read(&mut self) -> Value {
        let line = self.lines.recv_timeout(Duration::from_secs(15)).expect("the MCP server answered");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"))
    }

    /// Nothing more arrives within `ms`.
    pub fn silent_for(&mut self, ms: u64) -> bool {
        self.lines.recv_timeout(Duration::from_millis(ms)).is_err()
    }

    /// Sends a request and returns the full JSON-RPC response.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send_raw(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string());
        let r = self.read();
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], id, "responses come back in order");
        r
    }

    pub fn initialize(&mut self) -> Value {
        let r = self.request(
            "initialize",
            json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }),
        );
        self.send_raw(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        r["result"].clone()
    }

    /// Calls a tool. Returns the tool's JSON payload and whether it was an error.
    pub fn call(&mut self, tool: &str, args: Value) -> (Value, bool) {
        let r = self.request("tools/call", json!({ "name": tool, "arguments": args }));
        let result = &r["result"];
        let text = result["content"][0]["text"].as_str().expect("text content");
        (serde_json::from_str(text).expect("tool payload is JSON"), result["isError"].as_bool().unwrap_or(false))
    }

    pub fn ok(&mut self, tool: &str, args: Value) -> Value {
        let (v, err) = self.call(tool, args);
        assert!(!err, "{tool} failed: {v}");
        v
    }

    pub fn err(&mut self, tool: &str, args: Value) -> String {
        let (v, err) = self.call(tool, args);
        assert!(err, "{tool} should have failed: {v}");
        v["error"].as_str().unwrap_or_default().to_string()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
