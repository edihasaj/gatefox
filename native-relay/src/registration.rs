use std::{io, path::Path};
use codex_state::RemoteControlEnrollmentRecord;
use serde::Deserialize;

/// How long one read waits for a lock on the native database. A service restart stops every engine that has it open;
/// the next opener recovers or checkpoints the WAL under an exclusive lock, and a read without a busy timeout fails at
/// once with "database is locked". Three such exits in a row paused the relay for half an hour.
const BUSY_TIMEOUT_MS: u32 = 5000;
/// Attempts when sqlite3 itself fails (the lock outlived the timeout, or recovery was still running). A missing or
/// disabled registration is an answer, not a failure, and is never retried.
const READ_ATTEMPTS: u32 = 3;
const RETRY_DELAY_MS: u64 = 1000;

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
    let stdout = query_with_retry(Path::new("/usr/bin/sqlite3"), path, query, READ_ATTEMPTS, RETRY_DELAY_MS).await?;
    let rows: Vec<Registration> = serde_json::from_slice(&stdout).map_err(|_| io::Error::other("Invalid native registration metadata"))?;
    let mut matches = rows.into_iter().filter(|row| row.account_id == account_id && row.websocket_url == websocket.as_str());
    let row = matches.next().ok_or_else(|| io::Error::other("This account has no existing Codex Desktop machine registration"))?;
    if matches.next().is_some() || row.remote_control_enabled != Some(1) { return Err(io::Error::other("The original machine registration must already be enabled")); }
    Ok(RemoteControlEnrollmentRecord { websocket_url: row.websocket_url, account_id: row.account_id,
        app_server_client_name: Some(row.app_server_client_name), server_id: row.server_id,
        environment_id: row.environment_id, server_name: row.server_name, remote_control_enabled: Some(true) })
}

/// Run one read-only query with a busy timeout, retrying a failed sqlite3 run a bounded number of times.
pub(crate) async fn query_with_retry(sqlite: &Path, path: &Path, query: &str, attempts: u32, delay_ms: u64) -> io::Result<Vec<u8>> {
    let timeout = format!(".timeout {BUSY_TIMEOUT_MS}");
    for attempt in 1..=attempts.max(1) {
        let output = tokio::process::Command::new(sqlite).args(["-readonly", "-json", "-cmd", &timeout]).arg(path).arg(query).output().await?;
        if output.status.success() { return Ok(output.stdout); }
        if attempt < attempts { tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await; }
    }
    Err(io::Error::other("Cannot read the existing native machine registration"))
}

#[cfg(test)]
mod tests {
    use super::query_with_retry;
    use std::{path::Path, process::{Command, Stdio}, time::{Duration, Instant}};
    use std::io::Write;

    const SQLITE: &str = "/usr/bin/sqlite3";

    /// A private scratch directory removed when dropped; the crate has no tempfile dependency.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("relay-registration-{name}-{}-{nanos}", std::process::id()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn database(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("state.sqlite");
        let status = Command::new(SQLITE).arg(&path)
            .arg("PRAGMA journal_mode=WAL; CREATE TABLE r(a); INSERT INTO r VALUES(1);")
            .stdout(Stdio::null()).status().unwrap();
        assert!(status.success());
        path
    }

    /// Holds an exclusive lock on the database for `hold`, the way a recovering or checkpointing engine does.
    fn lock_for(path: &Path, hold: Duration) -> std::process::Child {
        let mut child = Command::new(SQLITE).arg(path).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let script = format!("PRAGMA locking_mode=EXCLUSIVE;\nBEGIN EXCLUSIVE;\nINSERT INTO r VALUES(2);\n.shell sleep {}\nCOMMIT;\n", hold.as_secs_f32());
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let started = Instant::now();
        // Wait until the lock is really held: a plain read without a timeout fails while it is.
        while Command::new(SQLITE).args(["-readonly"]).arg(path).arg("SELECT count(*) FROM r").stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success() {
            assert!(started.elapsed() < Duration::from_secs(5), "the lock was never taken");
            std::thread::sleep(Duration::from_millis(20));
        }
        child
    }

    #[tokio::test]
    async fn a_locked_native_database_is_waited_for_instead_of_failing_at_once() {
        if !Path::new(SQLITE).exists() { return; }
        let dir = Scratch::new("locked");
        let path = database(dir.path());
        let mut holder = lock_for(&path, Duration::from_millis(1500));
        let stdout = query_with_retry(Path::new(SQLITE), &path, "SELECT count(*) AS n FROM r", 1, 0).await.unwrap();
        assert_eq!(String::from_utf8(stdout).unwrap().trim(), r#"[{"n":2}]"#);
        holder.wait().unwrap();
    }

    #[tokio::test]
    async fn a_failing_read_is_retried_then_refused_with_its_fixed_reason() {
        if !Path::new(SQLITE).exists() { return; }
        let dir = Scratch::new("missing");
        let started = Instant::now();
        let error = query_with_retry(Path::new(SQLITE), &dir.path().join("missing").join("state.sqlite"), "SELECT 1", 3, 50).await.unwrap_err();
        assert_eq!(error.to_string(), "Cannot read the existing native machine registration");
        assert!(started.elapsed() >= Duration::from_millis(100), "both retries waited");
    }
}
