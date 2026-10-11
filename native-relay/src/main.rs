mod control;
mod frames;
mod lease;
mod registration;
mod session;
#[cfg(test)]
mod tests;

use codex_app_server_transport::{
    ConnectionId, ConnectionOrigin, OutgoingMessage, QueuedOutgoingMessage, DaemonShutdownAccess, app_server_control_socket_path, start_control_socket_acceptor,
    RemoteControlPolicy, RemoteControlStartConfig, RemoteControlStartupMode, TransportEvent,
    start_remote_control,
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
            if key == "--check" { check = true; continue; }
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
    if run().await.is_err() {
        eprintln!("gateway: Native relay stopped; private state retained");
        std::process::exit(1);
    }
}

async fn run() -> io::Result<()> {
    let options = Options::parse()?;
    let cli = tokio::process::Command::new(&options.codex).arg("--version").output().await?;
    if !cli.status.success() || String::from_utf8_lossy(&cli.stdout).trim() != "codex-cli 0.162.0-alpha.17.2" {
        return Err(io::Error::other("Native relay requires the matching Codex CLI build"));
    }
    if std::path::Path::new(&options.relay_home) == std::path::Path::new(&options.native_home) {
        return Err(io::Error::other("Relay state must be separate from the native home"));
    }
    let _lease = lease::acquire(std::path::Path::new(&options.relay_home))?;
    let config = ConfigBuilder::default()
        .codex_home(options.native_home.clone().into())
        .build()
        .await?;
    eprintln!("gateway: Native relay configuration loaded");
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
    eprintln!("gateway: Native relay host authenticated");
    let account = auth.auth_cached().and_then(|value| value.get_account_id()).ok_or_else(|| io::Error::other("Native host account is unavailable"))?;
    let registration = registration::read(&config.sqlite.state_db_path(), &account, &config.chatgpt_base_url).await?;
    let installation_id = tokio::fs::read_to_string(config.codex_home.join("installation_id")).await?.trim().to_string();
    uuid::Uuid::parse_str(&installation_id).map_err(|_| io::Error::other("Invalid original machine installation ID"))?;
    let expected_environment = registration.environment_id.clone();
    let client_name = registration.app_server_client_name.clone().unwrap();
    let home = AbsolutePathBuf::from_absolute_path(&options.relay_home)?;
    let state = StateRuntime::init(SqliteConfig::from_sqlite_home(home.clone()), "openai".into())
        .await
        .map_err(io::Error::other)?;
    state.upsert_remote_control_enrollment(&registration).await.map_err(io::Error::other)?;
    if options.check {
        println!("{}", json!({"ready":true,"existingMachine":true,"environmentId":expected_environment,"installationId":installation_id}));
        return Ok(());
    }
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
    let control_task = start_control_socket_acceptor(app_server_control_socket_path(&home)?, events_tx, stop.clone(), DaemonShutdownAccess::Disabled).await?;
    client_name_tx.send(client_name.clone()).map_err(|_| io::Error::other("Native registration scope closed"))?;
    if options.enable {
        handle.enable(Some(&client_name)).await?;
    } else {
        handle.resolve_persisted_preference(Some(&client_name)).await?;
    }
    let mut status = handle.status_receiver();
    let mut input = frames::FrameReader::new(BufReader::new(tokio::io::stdin()));
    let mut output = tokio::io::stdout();
    let mut sessions = HashMap::<_, (mpsc::Sender<Value>, CancellationToken)>::new();
    let mut controllers = HashMap::<ConnectionId, (mpsc::Sender<QueuedOutgoingMessage>, CancellationToken)>::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut auth_poll = tokio::time::interval(std::time::Duration::from_secs(5));
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
            _ = auth_poll.tick() => {
                auth.reload().await;
                if auth.auth_cached().and_then(|value| value.get_account_id()).as_deref() != Some(&account) { break; }
            },
            event = events.recv() => match event {
                Some(TransportEvent::ConnectionOpened { connection_id, origin: _, auth: Some(auth), writer, disconnect_sender }) => {
                    if sessions.len() >= 8 || !auth.is_current() { if let Some(token) = disconnect_sender { token.cancel(); } continue; }
                    let token = disconnect_sender.unwrap_or_else(|| stop.child_token());
                    let (tx, rx) = mpsc::channel(128); sessions.insert(connection_id, (tx, token.clone()));
                    let options = options.clone(); let handle = handle.clone();
                    tasks.spawn(async move { let _ = session::run(options, rx, writer, auth, token, handle).await; connection_id });
                    output.write_all(b"{\"event\":\"remote-client-connected\"}\n").await?;
                },
                Some(TransportEvent::ConnectionClosed { connection_id }) => {
                    if let Some((_, token)) = sessions.remove(&connection_id) { token.cancel(); }
                    if let Some((_, token)) = controllers.remove(&connection_id) { token.cancel(); }
                },
                Some(TransportEvent::IncomingMessage { connection_id, message }) => {
                    let value = serde_json::to_value(message).map_err(io::Error::other)?;
                    if let Some((writer, token)) = controllers.get(&connection_id) {
                        if let Some(reply) = control::response(&handle, &value).await {
                            if writer.try_send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(reply))).is_err() { token.cancel(); }
                        }
                        continue;
                    }
                    if let Some((tx, token)) = sessions.get(&connection_id) {
                        if tx.try_send(value).is_err() { token.cancel(); }
                    }
                },
                Some(TransportEvent::ConnectionOpened { connection_id, origin: ConnectionOrigin::WebSocket, auth: None, writer, disconnect_sender }) => {
                    let token = disconnect_sender.unwrap_or_else(|| stop.child_token());
                    if controllers.len() >= 8 { token.cancel(); } else { controllers.insert(connection_id, (writer, token)); }
                },
                Some(TransportEvent::ConnectionOpened { disconnect_sender: Some(token), .. }) => token.cancel(),
                None => break,
                _ => {},
            },
            result = tasks.join_next(), if !tasks.is_empty() => { if let Some(Ok(id)) = result { if let Some((_, token)) = sessions.remove(&id) { token.cancel(); } } },
            changed = status.changed() => {
                if changed.is_err() { break; }
                if status.borrow().environment_id.as_ref().is_some_and(|id| id != &expected_environment) { break; }
                let notification = json!({"method": "remoteControl/status/changed", "params": status.borrow_and_update().clone()});
                for (writer, token) in controllers.values() {
                    if writer.try_send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(notification.clone()))).is_err() { token.cancel(); }
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
    stop.cancel();
    for (_, (_, token)) in sessions {
        token.cancel();
    }
    for (_, (_, token)) in controllers { token.cancel(); }
    while tasks.join_next().await.is_some() {}
    let _ = remote_task.await;
    let _ = control_task.await;
    Ok(())
}
