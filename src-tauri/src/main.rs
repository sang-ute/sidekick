// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code launches this same executable with --mcp to use Sidekick's tools.
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        sidekick_lib::mcp::run();
        return;
    }
    sidekick_lib::run();
}
