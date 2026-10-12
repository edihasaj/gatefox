use crate::{
    Options, control,
    diagnostics::{self, Cause, SessionDiagnostics},
    frames::FrameReader,
    session_events::{self, SessionEvent},
};
use codex_app_server_transport::{
    ConnectionAuth, OutgoingMessage, QueuedOutgoingMessage, RemoteControlHandle,
};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

async fn forward(
    writer: &mpsc::Sender<QueuedOutgoingMessage>,
    auth: &ConnectionAuth,
    stop: &CancellationToken,
    diagnostics: &mut SessionDiagnostics,
    message: Value,
) -> Result<(), Cause> {
    if !auth.is_current() {
        return Err(Cause::AuthScopeChanged);
    }
    let metadata = diagnostics::lifecycle_metadata(&message);
    tokio::select! {
        biased;
        _ = stop.cancelled() => return Err(Cause::Cancelled),
        result = writer.send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(message))) => {
            result.map_err(|_| Cause::PeerClosed)?;
        },
    }
    if let Some(record) = diagnostics.queued(&metadata) {
        diagnostics::emit(&record);
    }
    Ok(())
}

pub async fn run(
    connection: u64,
    options: Options,
    mut incoming: mpsc::Receiver<Value>,
    writer: mpsc::Sender<QueuedOutgoingMessage>,
    auth: ConnectionAuth,
    stop: CancellationToken,
    handle: RemoteControlHandle,
) -> Cause {
    let mut diagnostics = SessionDiagnostics::new(connection);
    diagnostics::emit(&diagnostics.start());
    let child = Command::new(&options.gateway)
        .args([
            "codex-shim",
            "--config",
            &options.gateway_config,
            "--codex",
            &options.codex,
            "--",
            "app-server",
            "--listen",
            "stdio://",
        ])
        .env("CODEX_HOME", &options.native_home)
        .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1")
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_BASE_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(_) => {
            diagnostics::emit(&diagnostics.end(Cause::SpawnIo, &Default::default(), None));
            stop.cancel();
            return Cause::SpawnIo;
        }
    };
    let mut input = child.stdin.take().unwrap();
    let mut output = FrameReader::new(BufReader::new(child.stdout.take().unwrap()));
    let mut stderr = tokio::spawn(diagnostics::drain_stderr(child.stderr.take().unwrap()));
    let mut activity = tokio::time::interval(Duration::from_secs(30));
    activity.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    activity.tick().await;
    let cause = async {
        loop {
            match session_events::next(&mut output, &mut incoming, &stop, &mut activity).await {
                SessionEvent::Cancelled => return Cause::Cancelled,
                SessionEvent::Activity => {
                    if !auth.is_current() {
                        return Cause::AuthScopeChanged;
                    }
                    diagnostics::emit(&diagnostics.snapshot());
                }
                SessionEvent::Frame(frame) => {
                    let frame = match frame {
                        Ok(Some(frame)) => frame,
                        Ok(None) => return Cause::ChildEof,
                        Err(error) => return diagnostics::frame_cause(&error),
                    };
                    if !auth.is_current() {
                        return Cause::AuthScopeChanged;
                    }
                    let message: Value = match serde_json::from_slice(&frame) {
                        Ok(message) => message,
                        Err(_) => return Cause::JsonInvalid,
                    };
                    if message.get("method").and_then(Value::as_str)
                        == Some("remoteControl/status/changed")
                    {
                        continue;
                    }
                    if let Err(cause) =
                        forward(&writer, &auth, &stop, &mut diagnostics, message).await
                    {
                        return cause;
                    }
                }
                SessionEvent::Incoming(message) => {
                    let Some(message) = message else {
                        return Cause::IncomingClosed;
                    };
                    if !auth.is_current() {
                        return Cause::AuthScopeChanged;
                    }
                    diagnostics.received();
                    let reply = if let Some(reply) = control::network_guard(&message) {
                        Some(reply)
                    } else {
                        tokio::select! {
                            biased;
                            _ = stop.cancelled() => return Cause::Cancelled,
                            reply = control::response(&handle, &message) => reply,
                        }
                    };
                    if let Some(reply) = reply {
                        if let Err(cause) =
                            forward(&writer, &auth, &stop, &mut diagnostics, reply).await
                        {
                            return cause;
                        }
                    } else {
                        let mut frame = match serde_json::to_vec(&message) {
                            Ok(frame) => frame,
                            Err(_) => return Cause::JsonInvalid,
                        };
                        frame.push(b'\n');
                        tokio::select! {
                            biased;
                            _ = stop.cancelled() => return Cause::Cancelled,
                            result = input.write_all(&frame) => {
                                if result.is_err() { return Cause::ChildInputIo; }
                            },
                        }
                    }
                }
            }
        }
    }
    .await;
    drop(input);
    // Owned executor only. Never signal the signed desktop application or its daemon.
    let child_exit = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(status)) => Some(if status.success() {
            "success"
        } else {
            "failure"
        }),
        Ok(Err(_)) => Some(Cause::ChildWaitIo.label()),
        Err(_) => {
            if child.start_kill().is_err() {
                Some(Cause::ChildKillIo.label())
            } else {
                match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                    Ok(Ok(_)) => Some("terminated_owned_child"),
                    Ok(Err(_)) => Some(Cause::ChildWaitIo.label()),
                    Err(_) => Some(Cause::ChildShutdownTimeout.label()),
                }
            }
        }
    };
    let stderr_counts = match tokio::time::timeout(Duration::from_millis(250), &mut stderr).await {
        Ok(Ok(counts)) => counts,
        Ok(Err(_)) => diagnostics::StderrCounts {
            read_failed: true,
            ..Default::default()
        },
        Err(_) => {
            stderr.abort();
            let _ = stderr.await;
            diagnostics::StderrCounts {
                read_failed: true,
                ..Default::default()
            }
        }
    };
    diagnostics::emit(&diagnostics.end(cause, &stderr_counts, child_exit));
    stop.cancel();
    cause
}
