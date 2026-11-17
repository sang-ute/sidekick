// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Claude Code launches this same executable with --mcp to use Sidekick's tools.
    if args.first().map(String::as_str) == Some("--mcp") {
        sidekick_lib::mcp::run();
        return;
    }
    // Test builds only: stand in for the Claude Code CLI (see fake_claude.rs).
    #[cfg(feature = "test-support")]
    if !args.is_empty() && sidekick_lib::fake_claude::is_requested() {
        std::process::exit(sidekick_lib::fake_claude::run(&args));
    }
    sidekick_lib::run();
}
