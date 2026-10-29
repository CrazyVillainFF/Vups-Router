#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_server;
mod desktop_tools;
mod workspace;

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .manage(desktop_tools::DesktopToolState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let url = desktop_server::start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            let url = url
                .parse()
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("VupsRouter")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_list,
            workspace::workspace_pick,
            workspace::workspace_rename,
            workspace::workspace_remove,
            workspace::workspace_scan,
            workspace::workspace_read,
            desktop_tools::desktop_tool_set_policy,
            desktop_tools::desktop_tool_policy_status,
            desktop_tools::desktop_tool_execute,
            desktop_tools::desktop_tool_respond,
            desktop_tools::desktop_tool_grants_list,
            desktop_tools::desktop_tool_grant_revoke,
            desktop_tools::desktop_tool_grants_clear,
            desktop_tools::desktop_tool_approvals_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running VupsRouter");
}
