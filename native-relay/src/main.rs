mod control;
mod diagnostics;
#[cfg(test)]
mod diagnostics_tests;
mod frames;
mod lease;
mod registration;
mod relay_counters;
mod routing;
mod sdk_log;
mod sdk_log_labels;
#[cfg(test)]
mod sdk_log_tests;
mod session;
mod session_events;
mod shutdown;
#[cfg(test)]
mod tests;

use codex_app_server_transport::{
    ConnectionId, ConnectionOrigin, DaemonShutdownAccess, OutgoingMessage, QueuedOutgoingMessage,
    RemoteControlPolicy, RemoteControlStartConfig, RemoteControlStartupMode, TransportEvent,
    app_server_control_socket_path, start_control_socket_acceptor, start_remote_control,
};
use codex_core::config::ConfigBuilder;
use codex_login::AuthManager;
use codex_state::{SqliteConfig, StateRuntime};
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::{Value, json};
use std::{collections::HashMap, io};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

struct SessionEntry {
    writer: mpsc::Sender<Value>,
    stop: CancellationToken,
    task: tokio::task::Id,
}

fn session_admission(
    current_auth: bool,
    sessions: usize,
    tasks: usize,
    replacement: bool,
) -> Option<diagnostics::Cause> {
    if !current_auth {
        Some(diagnostics::Cause::AuthScopeChanged)
    } else if tasks >= 16 {
        Some(diagnostics::Cause::SessionTaskLimit)
    } else if sessions >= 8 && !replacement {
        Some(diagnostics::Cause::SessionLimit)
    } else {
        None
    }
}

fn finish_session(
    sessions: &mut HashMap<ConnectionId, SessionEntry>,
    connection: ConnectionId,
    task: tokio::task::Id,
) {
    if sessions
        .get(&connection)
        .is_some_and(|session| session.task == task)
    {
        if let Some(session) = sessions.remove(&connection) {
            session.stop.cancel();
        }
    }
}

fn cancel_queue_error<T>(
    connection: ConnectionId,
    event: &'static str,
    result: Result<(), mpsc::error::TrySendError<T>>,
    token: &CancellationToken,
) {
    if let Err(error) = result {
        let cause = match error {
            mpsc::error::TrySendError::Full(_) => diagnostics::Cause::QueueFull,
            mpsc::error::TrySendError::Closed(_) => diagnostics::Cause::QueueClosed,
        };
        diagnostics::emit(&diagnostics::record(event, connection.0, cause));
        token.cancel();
    }
}

#[derive(Clone)]
pub struct Options {
    native_home: String,
    relay_home: String,
    gateway: String,
    gateway_config: String,
    codex: String,
    daemon: bool,
    enable: bool,
    check: bool,
}

impl Options {
    fn parse() -> io::Result<Self> {
        let mut args = std::env::args().skip(1);
        let mut values = HashMap::new();
        let mut daemon = false;
        let mut enable = false;
        let mut check = false;
        while let Some(key) = args.next() {
            if key == "--daemon" {
                daemon = true;
                continue;
            }
            if key == "--enable" {
                enable = true;
                continue;
            }
            if key == "--check" {
                check = true;
                continue;
            }
            if ![
                "--native-home",
                "--relay-home",
                "--gateway",
                "--gateway-config",
                "--codex",
            ]
            .contains(&key.as_str())
            {
                return Err(io::Error::other("Unknown relay option"));
            }
            values.insert(
                key,
                args.next()
                    .ok_or_else(|| io::Error::other("Missing relay option value"))?,
            );
        }
        let mut required = |key: &str| {
            values
                .remove(key)
                .ok_or_else(|| io::Error::other(format!("Missing {key}")))
        };
        Ok(Self {
            native_home: required("--native-home")?,
            relay_home: required("--relay-home")?,
            gateway: required("--gateway")?,
            gateway_config: required("--gateway-config")?,
            codex: required("--codex")?,
            daemon,
            enable,
            check,
        })
    }
}

#[tokio::main]
async fn main() {
    sdk_log::install();
    diagnostics::install_panic_hook();
    if run().await.is_err() {
        diagnostics::emit_text("Native relay stopped; private state retained");
        std::process::exit(1);
    }
}

async fn run() -> io::Result<()> {
    let options = Options::parse()?;
    let cli = tokio::process::Command::new(&options.codex)
        .arg("--version")
        .output()
        .await?;
    if !cli.status.success()
        || String::from_utf8_lossy(&cli.stdout).trim() != "codex-cli 0.162.0-alpha.17.2"
    {
        return Err(io::Error::other(
            "Native relay requires the matching Codex CLI build",
        ));
    }
    if std::path::Path::new(&options.relay_home) == std::path::Path::new(&options.native_home) {
        return Err(io::Error::other(
            "Relay state must be separate from the native home",
        ));
    }
    let _lease = lease::acquire(std::path::Path::new(&options.relay_home))?;
    let config = ConfigBuilder::default()
        .codex_home(options.native_home.clone().into())
        .build()
        .await?;
    diagnostics::emit_text("Native relay configuration loaded");
    let policy = if config
        .config_layer_stack
        .requirements()
        .allow_remote_control
        .as_ref()
        .is_some_and(|value| !value.value)
    {
        RemoteControlPolicy::DisabledByRequirements
    } else {
        RemoteControlPolicy::Allowed
    };
    if policy != RemoteControlPolicy::Allowed {
        return Err(io::Error::other(
            "Remote control is disabled by managed requirements",
        ));
    }
    let auth = AuthManager::shared_from_config(&config, false)
        .await
        .map_err(io::Error::other)?;
    if !auth
        .auth_cached()
        .is_some_and(|value| value.uses_codex_backend())
    {
        return Err(io::Error::other(
            "Native relay requires ChatGPT host authentication",
        ));
    }
    diagnostics::emit_text("Native relay host authenticated");
    let account = auth
        .auth_cached()
        .and_then(|value| value.get_account_id())
        .ok_or_else(|| io::Error::other("Native host account is unavailable"))?;
    let registration = registration::read(
        &config.sqlite.state_db_path(),
        &account,
        &config.chatgpt_base_url,
    )
    .await?;
    let installation_id = tokio::fs::read_to_string(config.codex_home.join("installation_id"))
        .await?
        .trim()
        .to_string();
    uuid::Uuid::parse_str(&installation_id)
        .map_err(|_| io::Error::other("Invalid original machine installation ID"))?;
    let expected_environment = registration.environment_id.clone();
    let client_name = registration.app_server_client_name.clone().unwrap();
    let home = AbsolutePathBuf::from_absolute_path(&options.relay_home)?;
    let state = StateRuntime::init(
        SqliteConfig::from_sqlite_home(home.clone()),
        "openai".into(),
    )
    .await
    .map_err(io::Error::other)?;
    state
        .upsert_remote_control_enrollment(&registration)
        .await
        .map_err(io::Error::other)?;
    if options.check {
        println!(
            "{}",
            json!({"ready":true,"existingMachine":true,"environmentId":expected_environment,"installationId":installation_id})
        );
        return Ok(());
    }
    codex_app_server_transport::gateway_counters::set_inbound_reset_switch(
        std::path::Path::new(&options.relay_home).join("inbound-gap-reset"),
    );
    let stop = CancellationToken::new();
    let (events_tx, mut events) = mpsc::channel(128);
    let (client_name_tx, client_name_rx) = tokio::sync::oneshot::channel();
    let (remote_task, handle) = start_remote_control(
        RemoteControlStartConfig {
            server_name: Some(registration.server_name),
            remote_control_url: config.chatgpt_base_url.clone(),
            installation_id,
            policy,
        },
        Some(state),
        auth.clone(),
        events_tx.clone(),
        stop.clone(),
        Some(client_name_rx),
        RemoteControlStartupMode::ResolvePersisted,
    )
    .await?;
    let control_task = start_control_socket_acceptor(
        app_server_control_socket_path(&home)?,
        events_tx,
        stop.clone(),
        DaemonShutdownAccess::Disabled,
    )
    .await?;
    client_name_tx
        .send(client_name.clone())
        .map_err(|_| io::Error::other("Native registration scope closed"))?;
    if options.enable {
        handle.enable(Some(&client_name)).await?;
    } else {
        handle
            .resolve_persisted_preference(Some(&client_name))
            .await?;
    }
    let mut status = handle.status_receiver();
    let mut input = frames::FrameReader::new(BufReader::new(tokio::io::stdin()));
    let mut output = tokio::io::stdout();
    let mut sessions = HashMap::<ConnectionId, SessionEntry>::new();
    let mut controllers =
        HashMap::<ConnectionId, (mpsc::Sender<QueuedOutgoingMessage>, CancellationToken)>::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_connections = HashMap::<tokio::task::Id, ConnectionId>::new();
    let mut auth_poll = tokio::time::interval(std::time::Duration::from_secs(5));
    let mut transport_activity = tokio::time::interval(std::time::Duration::from_secs(30));
    transport_activity.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_transport = Value::Null;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
            _ = transport_activity.tick() => {
                if let Some(record) = relay_counters::activity_record(&mut last_transport) { diagnostics::emit(&record); }
            },
            _ = auth_poll.tick() => {
                auth.reload().await;
                if auth.auth_cached().and_then(|value| value.get_account_id()).as_deref() != Some(&account) { break; }
            },
            event = events.recv() => match event {
                Some(TransportEvent::ConnectionOpened { connection_id, origin: _, auth: Some(auth), writer, disconnect_sender }) => {
                    let cause = session_admission(auth.is_current(), sessions.len(), tasks.len(), sessions.contains_key(&connection_id));
                    if let Some(cause) = cause {
                        diagnostics::emit(&diagnostics::record("session_rejected", connection_id.0, cause));
                        if let Some(token) = disconnect_sender { token.cancel(); }
                        continue;
                    }
                    let token = disconnect_sender.unwrap_or_else(|| stop.child_token());
                    let (tx, rx) = mpsc::channel(128);
                    let session_options = options.clone(); let handle = handle.clone();
                    let task_token = token.clone();
                    let task = tasks.spawn(async move { session::run(connection_id.0, session_options, rx, writer, auth, task_token, handle).await });
                    task_connections.insert(task.id(), connection_id);
                    if let Some(old) = sessions.insert(connection_id, SessionEntry { writer:tx, stop:token, task:task.id() }) {
                        diagnostics::emit(&diagnostics::record("session_replaced", connection_id.0, diagnostics::Cause::Cancelled));
                        old.stop.cancel();
                    }
                    if let Some(notice) = routing::connected_notice(options.daemon) { output.write_all(notice).await?; }
                },
                Some(TransportEvent::ConnectionClosed { connection_id }) => {
                    if let Some(session) = sessions.remove(&connection_id) { session.stop.cancel(); }
                    if let Some((_, token)) = controllers.remove(&connection_id) { token.cancel(); }
                },
                Some(TransportEvent::IncomingMessage { connection_id, message }) => {
                    let value = serde_json::to_value(message).map_err(io::Error::other)?;
                    if let Some((writer, token)) = controllers.get(&connection_id) {
                        if let Some(reply) = control::response(&handle, &value).await {
                            cancel_queue_error(connection_id, "controller_queue_failed", writer.try_send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(reply))), token);
                        }
                        continue;
                    }
                    routing::deliver(&sessions, connection_id, value);
                },
                Some(TransportEvent::ConnectionOpened { connection_id, origin: ConnectionOrigin::WebSocket, auth: None, writer, disconnect_sender }) => {
                    let token = disconnect_sender.unwrap_or_else(|| stop.child_token());
                    if controllers.len() >= 8 && !controllers.contains_key(&connection_id) {
                        diagnostics::emit(&diagnostics::record("controller_rejected", connection_id.0, diagnostics::Cause::SessionLimit));
                        token.cancel();
                    } else if let Some((_, old)) = controllers.insert(connection_id, (writer, token)) { old.cancel(); }
                },
                Some(TransportEvent::ConnectionOpened { disconnect_sender: Some(token), .. }) => token.cancel(),
                None => break,
                _ => {},
            },
            result = tasks.join_next_with_id(), if !tasks.is_empty() => {
                let Some(result) = result else { continue; };
                let (task, cause) = match result {
                    Ok((task, cause)) => (task, cause),
                    Err(error) => (error.id(), if error.is_panic() { diagnostics::Cause::TaskPanic } else { diagnostics::Cause::TaskCancelled }),
                };
                if let Some(connection) = task_connections.remove(&task) {
                    diagnostics::emit(&diagnostics::record("session_task_finished", connection.0, cause));
                    finish_session(&mut sessions, connection, task);
                }
            },
            changed = status.changed() => {
                if changed.is_err() { break; }
                if status.borrow().environment_id.as_ref().is_some_and(|id| id != &expected_environment) { break; }
                let notification = json!({"method": "remoteControl/status/changed", "params": status.borrow_and_update().clone()});
                for (connection, (writer, token)) in &controllers {
                    cancel_queue_error(*connection, "controller_queue_failed", writer.try_send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(notification.clone()))), token);
                }
                let mut frame = serde_json::to_vec(&notification).map_err(io::Error::other)?;
                frame.push(b'\n'); output.write_all(&frame).await?;
                let path = std::path::Path::new(&options.relay_home).join("status.json");
                let temporary = path.with_extension("json.tmp");
                tokio::fs::write(&temporary, serde_json::to_vec(&status.borrow().clone()).map_err(io::Error::other)?).await?;
                #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?; }
                tokio::fs::rename(temporary, path).await?;
            },
            frame = input.next(), if !options.daemon => {
                let Some(frame) = frame? else { break };
                let request: Value = serde_json::from_slice(&frame).map_err(io::Error::other)?;
                if let Some(reply) = control::response(&handle, &request).await {
                    let mut frame = serde_json::to_vec(&reply).map_err(io::Error::other)?; frame.push(b'\n'); output.write_all(&frame).await?;
                }
            },
        }
    }
    shutdown::drain_then_stop(
        &mut sessions,
        &mut controllers,
        &mut events,
        &stop,
        std::time::Duration::from_secs(1),
    )
    .await;
    while let Some(result) = tasks.join_next_with_id().await {
        let (task, cause) = match result {
            Ok((task, cause)) => (task, cause),
            Err(error) => (
                error.id(),
                if error.is_panic() {
                    diagnostics::Cause::TaskPanic
                } else {
                    diagnostics::Cause::TaskCancelled
                },
            ),
        };
        if let Some(connection) = task_connections.remove(&task) {
            diagnostics::emit(&diagnostics::record(
                "session_task_finished",
                connection.0,
                cause,
            ));
        }
    }
    let _ = remote_task.await;
    let _ = control_task.await;
    Ok(())
}
