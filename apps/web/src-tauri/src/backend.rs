//! Trusted native setup: credentials never leave the local machine or appear in UI/logs.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_http::reqwest::{self, Client};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConnection {
    pub base_url: String,
    pub token: String,
    pub mode: String,
}
#[derive(Serialize, Deserialize)]
struct Service {
    port: u16,
    payload: PathBuf,
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate application data.")?;
    fs::create_dir_all(&path).map_err(|_| "Cannot create application data.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect application data.")?;
    }
    Ok(path)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot write service configuration.")?;
    file.write_all(bytes)
        .map_err(|_| "Cannot write service configuration.".into())
}
fn command(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // Do not include stdout/stderr: Docker exec can contain the access token.
    cmd.output()
        .map_err(|_| format!("Cannot run {program}. Make sure it is installed and available."))
}
fn checked(program: &str, args: &[&str]) -> Result<(), String> {
    if command(program, args)?.status.success() {
        Ok(())
    } else {
        Err(format!("{program} could not configure the per-user service. Check your user service manager permissions."))
    }
}
fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|_| "Cannot create backend installation directory.")?;
    for entry in
        fs::read_dir(source).map_err(|_| "Bundled backend is unavailable. Reinstall Vektor.")?
    {
        let entry = entry.map_err(|_| "Cannot read bundled backend.")?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(from, to).map_err(|_| "Cannot install bundled backend.")?;
        }
    }
    Ok(())
}
fn service(root: &Path) -> Result<Service, String> {
    serde_json::from_slice(
        &fs::read(root.join("service.json")).map_err(|_| "No local service is installed.")?,
    )
    .map_err(|_| "Local service configuration is invalid. Reinstall the service.".into())
}
#[cfg(target_os = "linux")]
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
#[cfg(target_os = "linux")]
fn register_service(app: &tauri::AppHandle, root: &Path, service: &Service) -> Result<(), String> {
    let dir = app
        .path()
        .config_dir()
        .map_err(|_| "Cannot locate user configuration.")?
        .join("systemd/user");
    fs::create_dir_all(&dir).map_err(|_| "Cannot create user service directory.")?;
    let quote = |p: PathBuf| unit_quote(&p.to_string_lossy());
    let text = format!("[Unit]\nDescription=Vektor local API\nAfter=network.target\n[Service]\nType=simple\nExecStart={} {} {} {}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\nUMask=0077\n[Install]\nWantedBy=default.target\n",
        quote(service.payload.join("node")), quote(service.payload.join("service-launcher.mjs")), quote(root.join("data")), service.port);
    write_private(&dir.join("vektor-api.service"), text.as_bytes())?;
    checked("systemctl", &["--user", "daemon-reload"])?;
    checked("systemctl", &["--user", "enable", "vektor-api.service"])
}
#[cfg(windows)]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(windows)]
fn register_service(_app: &tauri::AppHandle, root: &Path, service: &Service) -> Result<(), String> {
    // InteractiveToken uses the current user's existing login; no password or elevation.
    let user = command("whoami", &["/user", "/fo", "csv", "/nh"])?;
    if !user.status.success() {
        return Err("Cannot identify the current Windows account.".into());
    }
    let account = String::from_utf8_lossy(&user.stdout);
    let user = account
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim_matches('"');
    if !user.starts_with("S-1-")
        || !user
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
    {
        return Err("Cannot identify the Windows account SID.".into());
    }
    let user = xml(user);
    let host = service.payload.join("service-host.exe");
    fs::copy(
        std::env::current_exe().map_err(|_| "Cannot locate service host.")?,
        &host,
    )
    .map_err(|_| "Cannot install the background service host.")?;
    let node = xml(&host.to_string_lossy());
    let args = xml(&format!(
        "--api-service \"{}\" \"{}\" {}",
        service.payload.display(),
        root.join("data").display(),
        service.port
    ));
    let text = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>{node}</Command><Arguments>{args}</Arguments></Exec></Actions></Task>"#
    );
    let path = root.join("service-task.xml");
    write_private(&path, text.as_bytes())?;
    checked(
        "schtasks",
        &[
            "/Create",
            "/TN",
            &task_name(),
            "/XML",
            &path.to_string_lossy(),
            "/F",
        ],
    )
}
#[cfg(windows)]
fn task_name() -> String {
    // A distinct task per Windows user. Account names cannot contain backslashes themselves.
    format!(
        "Vektor API - {}",
        std::env::var("USERNAME").unwrap_or_else(|_| "User".into())
    )
}
fn start_service() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return checked("systemctl", &["--user", "start", "vektor-api.service"]);
    #[cfg(windows)]
    return checked("schtasks", &["/Run", "/TN", &task_name()]);
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("Local services support Windows and Linux.".into())
}
// Content identity prevents a fresh UI from reconnecting to an older API with
// the same package version (especially during desktop development).
fn payload_directory_name(manifest: &[u8]) -> Result<String, String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(manifest).map_err(|_| "Invalid bundled backend manifest.")?;
    let version = manifest["version"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && !v.contains("..")
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
        })
        .ok_or("Invalid backend version.")?;
    match manifest.get("buildId") {
        None => Ok(version.into()),
        Some(value) => {
            let id = value
                .as_str()
                .filter(|id| id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()))
                .ok_or("Invalid backend build identity.")?;
            Ok(format!("{version}-{id}"))
        }
    }
}
fn stop_service_for_update(root: &Path, service: &Service) -> Result<(), String> {
    let address = format!("127.0.0.1:{}", service.port)
        .parse()
        .map_err(|_| "Invalid service port.")?;
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err() {
        return Ok(());
    }
    write_private(&root.join("data/desktop-stop"), b"stop")?;
    for _ in 0..35 {
        if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err("The local API is still stopping. Retry after its current work has stopped.".into())
}
fn prepare_local(app: &tauri::AppHandle, install: bool) -> Result<BackendConnection, String> {
    let dir = root(app)?;
    let existing = if dir.join("service.json").exists() {
        Some(service(&dir)?)
    } else {
        None
    };
    if existing.is_none() && !install {
        return Err("No local service is installed.".into());
    }
    let bundle = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate bundled backend.")?
        .join("backend");
    let manifest = fs::read(bundle.join("manifest.json"))
        .map_err(|_| "Backend payload missing. Run pnpm desktop:prepare or reinstall Vektor.")?;
    let payload = dir.join("backend").join(payload_directory_name(&manifest)?);
    let changed = existing.as_ref().is_none_or(|previous| {
        previous.payload != payload
            || fs::read(previous.payload.join("manifest.json"))
                .ok()
                .as_deref()
                != Some(manifest.as_slice())
    });
    if changed {
        // Prepare a separate generation before stopping the working service.
        copy_tree(&bundle, &payload)?;
        let port = match &existing {
            Some(previous) => {
                stop_service_for_update(&dir, previous)?;
                previous.port
            }
            None => TcpListener::bind(("127.0.0.1", 8787))
                .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
                .map_err(|_| "No local API port is available.")?
                .local_addr()
                .map_err(|_| "Cannot choose a local API port.")?
                .port(),
        };
        let updated = Service { port, payload };
        let registration = register_service(app, &dir, &updated).and_then(|_| {
            write_private(
                &dir.join("service.json"),
                &serde_json::to_vec(&updated)
                    .map_err(|_| "Cannot serialize service configuration.")?,
            )
        });
        if let Err(error) = registration {
            if let Some(previous) = &existing {
                let _ = register_service(app, &dir, previous);
                let _ = start_service();
            }
            return Err(error);
        }
    }
    let service = service(&dir)?;
    start_service()?;
    Ok(BackendConnection {
        base_url: format!("http://127.0.0.1:{}", service.port),
        token: String::new(),
        mode: "local".into(),
    })
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize API connection.".into())
}
async fn validate(connection: &BackendConnection) -> Result<(), String> {
    let response = client()?
        .get(format!("{}/api/settings", connection.base_url))
        .bearer_auth(&connection.token)
        .send()
        .await
        .map_err(|_| "The API is not reachable. Check that it is running.")?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err("The API rejected automatic sign-in. Check the selected backend.".into())
    }
}
async fn local_connection(
    app: tauri::AppHandle,
    install: bool,
) -> Result<BackendConnection, String> {
    let handle = app.clone();
    let mut connection =
        tauri::async_runtime::spawn_blocking(move || prepare_local(&handle, install))
            .await
            .map_err(|_| "Service setup failed.")??;
    let token = root(&app)?.join("data/access-token");
    for _ in 0..60 {
        if let Ok(value) = fs::read_to_string(&token) {
            connection.token = value.trim().into();
            if validate(&connection).await.is_ok() {
                return Ok(connection);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("The service did not become ready. Check the API logs in the Vektor application data directory and retry.".into())
}
#[tauri::command]
pub async fn install_local_service(app: tauri::AppHandle) -> Result<BackendConnection, String> {
    local_connection(app, true).await
}
#[tauri::command]
pub async fn restore_backend(app: tauri::AppHandle) -> Result<Option<BackendConnection>, String> {
    let dir = root(&app)?;
    if let Ok(bytes) = fs::read(dir.join("connection.json")) {
        let saved: BackendConnection =
            serde_json::from_slice(&bytes).map_err(|_| "Saved connection is invalid.")?;
        if saved.mode == "docker" {
            // Re-read Docker credentials: they can change after a container is replaced.
            return connect_docker(app, saved.base_url).await.map(Some);
        }
        return local_connection(app, false).await.map(Some);
    }
    if dir.join("service.json").exists() {
        return local_connection(app, false).await.map(Some);
    }
    Ok(None)
}
#[tauri::command]
pub fn save_backend(app: tauri::AppHandle, connection: BackendConnection) -> Result<(), String> {
    super::local_backend(&connection.base_url)?;
    if !matches!(connection.mode.as_str(), "docker" | "local") || connection.token.is_empty() {
        return Err("Invalid backend connection.".into());
    }
    write_private(
        &root(&app)?.join("connection.json"),
        &serde_json::to_vec(&connection).map_err(|_| "Cannot serialize connection.")?,
    )
}
fn docker_connection(base: String) -> Result<BackendConnection, String> {
    let base = super::local_backend(&base)?;
    if std::env::var("DOCKER_HOST")
        .ok()
        .is_some_and(|host| !host.starts_with("unix://") && !host.starts_with("npipe://"))
    {
        return Err("Automatic sign-in requires a local Docker daemon. Unset the remote DOCKER_HOST setting.".into());
    }
    let endpoint = command(
        "docker",
        &[
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ],
    )?;
    let endpoint = String::from_utf8_lossy(&endpoint.stdout);
    if !endpoint.trim().starts_with("unix://") && !endpoint.trim().starts_with("npipe://") {
        return Err("Select a local Docker context. Remote Docker connections cannot be configured automatically.".into());
    }
    let list = command(
        "docker",
        &[
            "ps",
            "--filter",
            "label=com.docker.compose.service=vektor",
            "--format",
            "{{.ID}}",
        ],
    )?;
    if !list.status.success() {
        return Err("Docker is unavailable. Start Docker Desktop, or give your Linux account access to Docker.".into());
    }
    let labeled = command(
        "docker",
        &[
            "ps",
            "--filter",
            "label=app.vektor.role=api",
            "--format",
            "{{.ID}}",
        ],
    )?;
    if !labeled.status.success() {
        return Err("Cannot discover local Docker APIs.".into());
    }
    let mut ids: Vec<String> = String::from_utf8_lossy(&list.stdout)
        .lines()
        .map(str::to_owned)
        .collect();
    ids.extend(
        String::from_utf8_lossy(&labeled.stdout)
            .lines()
            .map(str::to_owned),
    );
    ids.sort();
    ids.dedup();
    let port = reqwest::Url::parse(&base)
        .map_err(|_| "Invalid API URL.")?
        .port_or_known_default()
        .ok_or("Missing API port.")?
        .to_string();
    for id in ids.iter().map(String::as_str) {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let inspect = command(
            "docker",
            &["inspect", "--format", "{{json .NetworkSettings.Ports}}", id],
        )?;
        let ports: serde_json::Value = serde_json::from_slice(&inspect.stdout)
            .map_err(|_| "Cannot inspect Docker API port.")?;
        let matches = ports["8787/tcp"].as_array().is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding["HostPort"].as_str() == Some(port.as_str())
                    && matches!(
                        binding["HostIp"].as_str(),
                        Some("127.0.0.1" | "0.0.0.0" | "::" | "::1")
                    )
            })
        });
        if !matches {
            continue;
        }
        let output = command("docker", &["exec", id, "node", "-e", "process.stdout.write(process.env.VEKTOR_ACCESS_TOKEN || require('node:fs').readFileSync((process.env.VEKTOR_DATA_DIR || '/data') + '/access-token','utf8').trim())"])?;
        if !output.status.success() {
            return Err("The Docker API is still starting. Wait a moment and retry.".into());
        }
        let token =
            String::from_utf8(output.stdout).map_err(|_| "Cannot read Docker credentials.")?;
        if token.trim().len() < 16 {
            return Err("Docker credentials are not ready yet.".into());
        }
        return Ok(BackendConnection {
            base_url: base,
            token: token.trim().into(),
            mode: "docker".into(),
        });
    }
    Err("No Vektor Docker API publishes that port. Run the Docker installer or docker compose up -d, then retry.".into())
}
#[tauri::command]
pub async fn connect_docker(
    _app: tauri::AppHandle,
    base_url: String,
) -> Result<BackendConnection, String> {
    let connection = tauri::async_runtime::spawn_blocking(move || docker_connection(base_url))
        .await
        .map_err(|_| "Docker discovery failed.")??;
    validate(&connection).await?;
    Ok(connection)
}
// The scheduled task runs this windowless native host rather than a console Node
// process. A private copy also lets NSIS update the main desktop executable.
#[cfg(windows)]
pub fn service_host() -> Option<i32> {
    use std::os::windows::process::CommandExt;
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|v| v.to_str()) != Some("--api-service") {
        return None;
    }
    if args.len() != 5 {
        return Some(1);
    }
    let payload = PathBuf::from(&args[2]);
    Some(
        Command::new(payload.join("node.exe"))
            .arg(payload.join("service-launcher.mjs"))
            .arg(&args[3])
            .arg(&args[4])
            .creation_flags(0x08000000)
            .status()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1),
    )
}
pub async fn stop_local_service(app: tauri::AppHandle) -> Result<(), String> {
    let dir = root(&app)?;
    if !dir.join("service.json").exists() {
        return Ok(());
    }
    // Only stop a service owned by this installation. Never stop external Docker APIs.
    let connection = service(&dir)?;
    if std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", connection.port)
            .parse()
            .map_err(|_| "Invalid service port.")?,
        Duration::from_millis(200),
    )
    .is_err()
    {
        return Ok(());
    }
    write_private(&dir.join("data/desktop-stop"), b"stop")?;
    for _ in 0..35 {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", connection.port)
                .parse()
                .map_err(|_| "Invalid service port.")?,
            Duration::from_millis(200),
        )
        .is_err()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err("The local API has not stopped yet. Wait a moment and try quitting again.".into())
}
#[cfg(test)]
mod tests {
    #[test]
    fn same_version_backend_changes_get_distinct_payloads() {
        let first = format!(r#"{{"version":"0.1.0","buildId":"{}"}}"#, "a".repeat(64));
        let second = format!(r#"{{"version":"0.1.0","buildId":"{}"}}"#, "b".repeat(64));
        assert_ne!(
            super::payload_directory_name(first.as_bytes()).unwrap(),
            super::payload_directory_name(second.as_bytes()).unwrap()
        );
        assert_eq!(
            super::payload_directory_name(br#"{"version":"0.1.0"}"#).unwrap(),
            "0.1.0"
        );
    }
    #[test]
    fn backend_payload_names_reject_path_traversal() {
        assert!(super::payload_directory_name(br#"{"version":"../outside"}"#).is_err());
        assert!(
            super::payload_directory_name(br#"{"version":"0.1.0","buildId":"../outside"}"#)
                .is_err()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_paths_cannot_expand_specifiers_or_environment() {
        assert_eq!(
            super::unit_quote("/a b/%x/$HOME/\"x\""),
            "\"/a b/%%x/$$HOME/\\\"x\\\"\""
        );
    }
}
