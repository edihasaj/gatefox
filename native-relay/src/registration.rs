use std::{io, path::Path};
use codex_state::RemoteControlEnrollmentRecord;
use serde::Deserialize;

#[derive(Deserialize)]
struct Registration {
    websocket_url: String, account_id: String, app_server_client_name: String,
    server_id: String, environment_id: String, server_name: String,
    remote_control_enabled: Option<i64>,
}

/// Read only the existing registration. No auth, transcript, or primary DB writes.
pub async fn read(path: &Path, account_id: &str, base_url: &str) -> io::Result<RemoteControlEnrollmentRecord> {
    let mut base = url::Url::parse(base_url).map_err(io::Error::other)?;
    if !base.path().ends_with('/') { base.set_path(&format!("{}/", base.path())); }
    let mut websocket = base.join("wham/remote/control/server").map_err(io::Error::other)?;
    websocket.set_scheme(if base.scheme() == "https" { "wss" } else { "ws" }).map_err(|_| io::Error::other("Invalid native endpoint"))?;
    let query = "SELECT websocket_url, account_id, app_server_client_name, server_id, environment_id, server_name, remote_control_enabled FROM remote_control_enrollments WHERE app_server_client_name = 'Codex Desktop'";
    let output = tokio::process::Command::new("/usr/bin/sqlite3").args(["-readonly", "-json"]).arg(path).arg(query).output().await?;
    if !output.status.success() { return Err(io::Error::other("Cannot read the existing native machine registration")); }
    let rows: Vec<Registration> = serde_json::from_slice(&output.stdout).map_err(|_| io::Error::other("Invalid native registration metadata"))?;
    let mut matches = rows.into_iter().filter(|row| row.account_id == account_id && row.websocket_url == websocket.as_str());
    let row = matches.next().ok_or_else(|| io::Error::other("This account has no existing Codex Desktop machine registration"))?;
    if matches.next().is_some() || row.remote_control_enabled != Some(1) { return Err(io::Error::other("The original machine registration must already be enabled")); }
    Ok(RemoteControlEnrollmentRecord { websocket_url: row.websocket_url, account_id: row.account_id,
        app_server_client_name: Some(row.app_server_client_name), server_id: row.server_id,
        environment_id: row.environment_id, server_name: row.server_name, remote_control_enabled: Some(true) })
}
