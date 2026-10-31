#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tauri_plugin_http::reqwest::{self, Client, Url};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Default)]
struct Connection {
    base_url: String,
    token: String,
    notifications: bool,
    generation: u64,
}

#[derive(Default)]
struct DesktopState(Mutex<Connection>);

fn local_backend(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Invalid backend URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Choose a local backend URL without paths or credentials.".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[tauri::command]
fn configure_connection(
    state: State<DesktopState>,
    base_url: String,
    token: String,
    notifications: bool,
) -> Result<(), String> {
    let base_url = local_backend(&base_url)?;
    let mut connection = state.0.lock().map_err(|_| "Connection unavailable.")?;
    connection.generation += 1;
    connection.base_url = base_url;
    connection.token = token;
    connection.notifications = notifications;
    Ok(())
}

#[tauri::command]
fn clear_connection(state: State<DesktopState>) {
    if let Ok(mut connection) = state.0.lock() {
        let generation = connection.generation + 1;
        *connection = Connection {
            generation,
            ..Default::default()
        };
    }
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn connection(app: &tauri::AppHandle) -> Option<Connection> {
    app.state::<DesktopState>()
        .0
        .lock()
        .ok()
        .map(|value| value.clone())
        .filter(|value| !value.token.is_empty())
}

fn action_path(action: &str) -> Option<&'static str> {
    match action {
        "pause" => Some("/api/scheduler/pause"),
        "resume" => Some("/api/scheduler/resume"),
        "stop" => Some("/api/runtime/emergency-stop"),
        _ => None,
    }
}

async fn tray_action(app: tauri::AppHandle, client: Client, action: String) {
    let result = match (connection(&app), action_path(&action)) {
        (Some(connection), Some(path)) => client.post(format!("{}{path}", connection.base_url))
            .bearer_auth(connection.token).send().await
            .map_err(|_| "Cannot reach backend. Check the connection.".to_owned())
            .and_then(|response| if response.status().is_success() { Ok(()) } else {
                Err(format!("Backend rejected tray action ({}). Unlock the workspace and check its status.", response.status()))
            }),
        _ => Err("Unlock the workspace before using tray controls.".into()),
    };
    let message = match result {
        Ok(()) => match action.as_str() {
            "pause" => "Scheduler paused. Active runs continue.",
            "resume" => "Scheduler resumed. Emergency stop, if active, still blocks runs.",
            _ => "Emergency stop activated. New runs are blocked.",
        }
        .to_owned(),
        Err(error) => {
            show(&app);
            error
        }
    };
    let _ = app.emit("desktop:notice", message);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    status: String,
}
#[derive(Deserialize)]
struct Runs {
    runs: Vec<Run>,
}

// The first successful poll is a baseline: opening the app never replays old notifications.
fn completed_runs(previous: &mut Option<HashMap<String, String>>, runs: Vec<Run>) -> Vec<String> {
    let notifications = match previous.as_ref() {
        None => vec![],
        Some(known) => runs
            .iter()
            .filter(|run| {
                matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
                    && known.get(&run.id) != Some(&run.status)
            })
            .map(|run| run.status.clone())
            .collect(),
    };
    *previous = Some(runs.into_iter().map(|run| (run.id, run.status)).collect());
    notifications
}

async fn monitor(app: tauri::AppHandle, client: Client) {
    let mut generation = 0;
    let mut previous = None;
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Some(connection) = connection(&app) else {
            previous = None;
            continue;
        };
        if generation != connection.generation {
            generation = connection.generation;
            previous = None;
        }
        if !connection.notifications {
            continue;
        }
        let response = client
            .get(format!("{}/api/runs", connection.base_url))
            .bearer_auth(&connection.token)
            .send()
            .await;
        if let Ok(response) = response {
            if !response.status().is_success() {
                continue;
            }
            if let Ok(text) = response.text().await {
                let Ok(runs) = serde_json::from_str::<Runs>(&text) else {
                    continue;
                };
                if self::connection(&app).is_none_or(|current| current.generation != generation) {
                    continue;
                }
                for status in completed_runs(&mut previous, runs.runs) {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Vektor")
                        .body(format!("Run {status}. Open Vektor to view the result."))
                        .show();
                }
            }
        }
    }
}

fn main() {
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client");
    tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            configure_connection,
            clear_connection
        ])
        .setup(move |app| {
            let show_item = MenuItem::with_id(app, "show", "Open Vektor", true, None::<&str>)?;
            let connection_item =
                MenuItem::with_id(app, "connection", "Backend connection…", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause scheduler", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "Resume scheduler", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Emergency stop", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit desktop (backend keeps running)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &connection_item, &pause, &resume, &stop, &quit],
            )?;
            let tray_client = client.clone();
            let tray = TrayIconBuilder::with_id("vektor")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("Vektor · Backend runs independently")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => show(app),
                        "connection" => {
                            show(app);
                            let _ = app.emit("desktop:connection", ());
                        }
                        "quit" => app.exit(0),
                        _ => {
                            tauri::async_runtime::spawn(tray_action(
                                app.clone(),
                                tray_client.clone(),
                                id.to_owned(),
                            ));
                        }
                    }
                })
                .build(app);
            // With no tray support, retain normal close behavior so the app stays recoverable.
            if tray.is_ok() {
                let window = app.get_webview_window("main").expect("main window");
                let hide = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if hide.hide().is_ok() {
                            api.prevent_close();
                        }
                    }
                });
            }
            tauri::async_runtime::spawn(monitor(app.handle().clone(), client.clone()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Vektor desktop failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipped_http_scope_parses_and_only_matches_loopback() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let entries = config["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|permission| permission["identifier"] == "http:default")
            .unwrap()["allow"]
            .as_array()
            .unwrap();
        let patterns: Vec<urlpattern::UrlPattern> = entries
            .iter()
            .map(|entry| {
                let raw = entry["url"].as_str().unwrap();
                let mut init =
                    urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(raw, None)
                        .unwrap();
                init.search = Some("*".into());
                init.hash = Some("*".into());
                urlpattern::UrlPattern::parse(init, Default::default()).unwrap()
            })
            .collect();
        for (url, expected) in [
            ("http://127.0.0.1:8787/healthz", true),
            ("http://localhost:18787/api/runs?after=1", true),
            ("https://[::1]:9876/api/runs", true),
            ("http://example.com:8787/api/runs", false),
            ("http://127.0.0.2:8787/healthz", false),
            ("http://localhost.evil.example/api/runs", false),
        ] {
            assert_eq!(
                patterns.iter().any(|pattern| pattern
                    .test(urlpattern::UrlPatternMatchInput::Url(
                        Url::parse(url).unwrap()
                    ))
                    .unwrap()),
                expected,
                "{url}"
            );
        }
    }
    fn run(id: &str, status: &str) -> Run {
        Run {
            id: id.into(),
            status: status.into(),
        }
    }
    #[test]
    fn accepts_only_local_backend_origins() {
        for url in [
            "http://localhost:8787",
            "http://127.0.0.1:8787/",
            "http://[::1]:8787",
        ] {
            assert!(local_backend(url).is_ok(), "{url}");
        }
        for url in [
            "https://example.com",
            "file:///etc/passwd",
            "http://localhost:8787/api",
            "http://user@localhost:8787",
            "http://localhost:8787?token=secret",
        ] {
            assert!(local_backend(url).is_err(), "{url}");
        }
    }
    #[test]
    fn notifies_once_for_transitions_and_short_runs_without_replaying_history() {
        let mut previous = None;
        assert!(completed_runs(
            &mut previous,
            vec![run("old", "completed"), run("a", "running")]
        )
        .is_empty());
        assert_eq!(
            completed_runs(
                &mut previous,
                vec![
                    run("old", "completed"),
                    run("a", "completed"),
                    run("b", "failed")
                ]
            ),
            vec!["completed", "failed"]
        );
        assert!(completed_runs(
            &mut previous,
            vec![run("a", "completed"), run("b", "failed")]
        )
        .is_empty());
    }
    #[test]
    fn tray_actions_have_fixed_api_paths() {
        assert_eq!(action_path("stop"), Some("/api/runtime/emergency-stop"));
        assert_eq!(action_path("pause"), Some("/api/scheduler/pause"));
        assert_eq!(action_path("resume"), Some("/api/scheduler/resume"));
        assert_eq!(action_path("approve"), None);
    }
}
