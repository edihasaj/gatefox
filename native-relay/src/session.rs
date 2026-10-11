use crate::{Options, control, frames::FrameReader};
use codex_app_server_transport::{
    ConnectionAuth, OutgoingMessage, QueuedOutgoingMessage, RemoteControlHandle,
};
use serde_json::Value;
use std::{collections::HashSet, io, process::Stdio};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

pub async fn run(
    options: Options,
    mut incoming: mpsc::Receiver<Value>,
    writer: mpsc::Sender<QueuedOutgoingMessage>,
    auth: ConnectionAuth,
    stop: CancellationToken,
    handle: RemoteControlHandle,
) -> io::Result<()> {
    let mut child = Command::new(&options.gateway)
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
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().unwrap();
    let mut output = FrameReader::new(BufReader::new(child.stdout.take().unwrap()));
    let mut model_requests = HashSet::new();
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                frame = output.next() => {
                    let Some(frame) = frame? else { break };
                    if !auth.is_current() { break }
                    let message: Value = serde_json::from_slice(&frame).map_err(io::Error::other)?;
                    if message.get("id").is_some_and(|id| model_requests.remove(&id.to_string())) {
                        if let Some(data) = message.get("result").and_then(|v| v.get("data")).and_then(Value::as_array) {
                            eprintln!("gateway: Remote model catalog returned {} rows", data.len());
                        }
                    }
                    if message.get("method").and_then(Value::as_str) == Some("remoteControl/status/changed") { continue; }
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        result = writer.send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(message))) => { result.map_err(io::Error::other)?; },
                    }
                }
                message = incoming.recv() => {
                    let Some(message) = message else { break };
                    if !auth.is_current() { break }
                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        if method == "model/list" && model_requests.len() < 256 {
                            if let Some(id) = message.get("id") {
                                let key = id.to_string(); if key.len() <= 1024 { model_requests.insert(key); }
                            }
                        }
                        if ["initialize", "initialized", "model/list", "thread/start", "thread/resume", "thread/settings/update", "turn/start", "turn/steer", "turn/interrupt", "turn/settings/update", "thread/goal/set", "thread/goal/get", "thread/goal/clear"].contains(&method) {
                            eprintln!("gateway: Remote RPC {}", method);
                        }
                    }
                    if let Some(reply) = control::network_guard(&message) {
                        writer.send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(reply))).await.map_err(io::Error::other)?;
                    } else if let Some(reply) = control::response(&handle, &message).await {
                        writer.send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(reply))).await.map_err(io::Error::other)?;
                    } else {
                        let mut frame = serde_json::to_vec(&message).map_err(io::Error::other)?;
                        frame.push(b'\n');
                        tokio::select! {
                            _ = stop.cancelled() => break,
                            result = input.write_all(&frame) => { result?; },
                        }
                    }
                }
            }
        }
        Ok(())
    }.await;
    drop(input);
    // Owned executor only. Never signal the signed desktop application or its daemon.
    if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        child.start_kill()?;
        let _ = child.wait().await;
    }
    stop.cancel();
    result
}
