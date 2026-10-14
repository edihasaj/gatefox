//! Gateway: over a real websocket, a relay-side stream end reaches the backend as the stream's
//! last reply followed by an unknown pong. A client close produces no pong.

use super::*;
use pretty_assertions::assert_eq;

async fn next_text_event(
    websocket: &mut WebSocketStream<TcpStream>,
    wait: Duration,
) -> Option<serde_json::Value> {
    loop {
        let frame = match timeout(wait, websocket.next()).await {
            Err(_) => return None,
            Ok(frame) => frame
                .expect("websocket should stay open")
                .expect("websocket frame should be readable"),
        };
        match frame {
            tungstenite::Message::Text(text) => {
                return Some(serde_json::from_str(text.as_ref()).expect("server event json"));
            }
            tungstenite::Message::Ping(payload) => websocket
                .send(tungstenite::Message::Pong(payload))
                .await
                .expect("pong should send"),
            _ => {}
        }
    }
}

fn stream_envelope(event: ClientEvent, stream: &str, seq_id: u64) -> ClientEnvelope {
    ClientEnvelope {
        event,
        client_id: ClientId("client-1".to_string()),
        stream_id: Some(StreamId(stream.to_string())),
        seq_id: Some(seq_id),
        cursor: None,
    }
}

fn stream_initialize(stream: &str) -> ClientEnvelope {
    let message = JSONRPCMessage::Request(codex_app_server_protocol::JSONRPCRequest {
        id: codex_app_server_protocol::RequestId::Integer(1),
        method: "initialize".to_string(),
        params: Some(json!({"clientInfo": {"name": "remote-test-client", "version": "0.1.0"}})),
        trace: None,
    });
    stream_envelope(ClientEvent::ClientMessage { message }, stream, 0)
}

async fn opened_stream(
    transport_event_rx: &mut mpsc::Receiver<TransportEvent>,
) -> (
    crate::outgoing_message::ConnectionId,
    mpsc::Sender<QueuedOutgoingMessage>,
    CancellationToken,
) {
    let opened = match timeout(Duration::from_secs(5), transport_event_rx.recv())
        .await
        .expect("connection open should arrive in time")
        .expect("connection open should exist")
    {
        TransportEvent::ConnectionOpened {
            connection_id,
            writer,
            disconnect_sender: Some(disconnect),
            ..
        } => (connection_id, writer, disconnect),
        other => panic!("expected connection open event, got {other:?}"),
    };
    match timeout(Duration::from_secs(5), transport_event_rx.recv())
        .await
        .expect("initialize should arrive in time")
        .expect("initialize should exist")
    {
        TransportEvent::IncomingMessage { connection_id, .. } => assert_eq!(connection_id, opened.0),
        other => panic!("expected forwarded initialize, got {other:?}"),
    }
    opened
}

async fn expect_closed(
    transport_event_rx: &mut mpsc::Receiver<TransportEvent>,
    expected: crate::outgoing_message::ConnectionId,
) {
    match timeout(Duration::from_secs(5), transport_event_rx.recv())
        .await
        .expect("connection close should arrive in time")
        .expect("connection close should exist")
    {
        TransportEvent::ConnectionClosed { connection_id } => assert_eq!(connection_id, expected),
        other => panic!("expected connection close event, got {other:?}"),
    }
}

#[tokio::test]
async fn relay_stream_end_reaches_backend_after_last_reply_and_client_close_does_not() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener should bind");
    let remote_control_url = remote_control_url_for_listener(&listener);
    let codex_home = TempDir::new().expect("temp dir should create");
    let state_db = remote_control_state_runtime(&codex_home).await;
    let (transport_event_tx, mut transport_event_rx) =
        mpsc::channel::<TransportEvent>(CHANNEL_CAPACITY);
    let shutdown_token = CancellationToken::new();
    let (remote_task, _remote_handle) = start_remote_control(
        RemoteControlStartConfig {
            server_name: None,
            remote_control_url,
            installation_id: TEST_INSTALLATION_ID.to_string(),
            policy: RemoteControlPolicy::Allowed,
        },
        Some(state_db),
        remote_control_auth_manager(),
        transport_event_tx,
        shutdown_token.clone(),
        /*app_server_client_name_rx*/ None,
        RemoteControlStartupMode::EnabledEphemeral,
    )
    .await
    .expect("remote control should start");
    let enroll_request = accept_http_request(&listener).await;
    respond_with_json(
        enroll_request.stream,
        remote_control_server_token_response(
            "srv_e_test",
            "env_test",
            TEST_REMOTE_CONTROL_SERVER_TOKEN,
        ),
    )
    .await;
    let mut websocket = accept_remote_control_connection(&listener).await;

    // The app side (the relay) ends stream-1 right after queueing its last reply.
    send_client_event(&mut websocket, stream_initialize("stream-1")).await;
    let (first, writer, disconnect) = opened_stream(&mut transport_event_rx).await;
    writer
        .send(QueuedOutgoingMessage::new(OutgoingMessage::Passthrough(
            json!({"id": 7, "result": {}}),
        )))
        .await
        .expect("reply should queue");
    disconnect.cancel();
    let reply = next_text_event(&mut websocket, Duration::from_secs(5))
        .await
        .expect("the last reply should reach the backend");
    assert_eq!(
        (
            reply["type"].clone(),
            reply["stream_id"].clone(),
            reply["seq_id"].clone(),
            reply["message"]["id"].clone(),
        ),
        (json!("server_message"), json!("stream-1"), json!(1), json!(7))
    );
    let pong = next_text_event(&mut websocket, Duration::from_secs(5))
        .await
        .expect("the unknown pong should follow the reply");
    assert_eq!(
        pong,
        json!({"type": "pong", "client_id": "client-1", "stream_id": "stream-1", "seq_id": 2, "status": "unknown"})
    );
    expect_closed(&mut transport_event_rx, first).await;

    // A client close is the client's own decision: no pong follows it.
    send_client_event(&mut websocket, stream_initialize("stream-2")).await;
    let (second, _writer, _disconnect) = opened_stream(&mut transport_event_rx).await;
    send_client_event(
        &mut websocket,
        stream_envelope(ClientEvent::ClientClosed, "stream-2", 1),
    )
    .await;
    expect_closed(&mut transport_event_rx, second).await;
    assert_eq!(
        next_text_event(&mut websocket, Duration::from_millis(300)).await,
        None,
        "a client close must not produce a pong"
    );

    shutdown_token.cancel();
    let _ = remote_task.await;
}
