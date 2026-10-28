#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if let Some(code) = agent_workspace::credentials::helper_mode() {
        std::process::exit(code);
    }
    agent_workspace::run();
}
