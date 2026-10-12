use crate::{
    SessionEntry, cancel_queue_error,
    diagnostics::{self, Cause, SessionDiagnostics},
    finish_session,
    frames::{FrameReader, MAX_FRAME},
    session_admission,
    session_events::{self, SessionEvent},
};
use codex_app_server_transport::ConnectionId;
use serde_json::{Value, json};
use std::{collections::HashMap, io};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

const THREAD: &str = "01a12f23-9d7d-7ca0-8e55-5c54ae8379fd";
const TURN: &str = "01a12f23-9d7d-7ca0-8e55-5c54ae8379fe";

#[test]
fn failed_log_writes_cannot_recurse_into_another_panic() {
    struct BrokenWriter;
    impl io::Write for BrokenWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("private OS error"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    diagnostics::write_record(
        &mut BrokenWriter,
        &diagnostics::record("panic_observed", 1, Cause::TaskPanic),
    );
}

#[tokio::test]
async fn continuously_ready_output_does_not_starve_ui_stop() {
    let bytes = b"{}\n".repeat(10_000);
    let mut frames = FrameReader::new(BufReader::new(bytes.as_slice()));
    let (writer, mut reader) = mpsc::channel(1);
    writer
        .send(json!({"method":"turn/interrupt","params":{"threadId":THREAD,"turnId":TURN}}))
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let mut activity = tokio::time::interval(std::time::Duration::from_secs(30));
    activity.tick().await;
    for _ in 0..256 {
        match session_events::next(&mut frames, &mut reader, &stop, &mut activity).await {
            SessionEvent::Incoming(Some(message)) => {
                assert_eq!(message["method"], "turn/interrupt");
                return;
            }
            SessionEvent::Frame(Ok(Some(_))) => {}
            _ => panic!("unexpected event while output and Stop were ready"),
        }
    }
    panic!("Stop was starved by continuously ready child output");
}

#[test]
fn reconnect_churn_cannot_create_unbounded_retiring_tasks() {
    assert_eq!(
        session_admission(false, 0, 0, false),
        Some(Cause::AuthScopeChanged)
    );
    assert_eq!(
        session_admission(true, 8, 8, false),
        Some(Cause::SessionLimit)
    );
    assert_eq!(session_admission(true, 8, 8, true), None);
    assert_eq!(
        session_admission(true, 0, 16, false),
        Some(Cause::SessionTaskLimit)
    );
    assert_eq!(
        session_admission(true, 8, 16, true),
        Some(Cause::SessionTaskLimit)
    );
}

fn observe(diagnostics: &mut SessionDiagnostics, message: Value) -> Option<Value> {
    diagnostics.queued(&diagnostics::lifecycle_metadata(&message))
}

#[test]
fn real_lifecycle_is_counted_and_preserves_only_trusted_metadata() {
    let mut state = SessionDiagnostics::new(17);
    assert_eq!(state.start()["event"], "session_started");
    state.received();
    let start = observe(
        &mut state,
        json!({"method":"turn/started", "emittedAtMs":123,
        "params":{"threadId":THREAD,"turn":{"id":TURN,"status":"inProgress", "items":["secret"]}}}),
    )
    .unwrap();
    assert_eq!(start["threadId"], THREAD);
    assert_eq!(start["turnId"], TURN);
    assert_eq!(start["sdkEmittedAtMs"], 123);
    assert_eq!(start["observedActiveTurns"], 1);
    let end = observe(
        &mut state,
        json!({"method":"turn/completed", "params":{"threadId":THREAD,
        "turn":{"id":TURN,"status":"interrupted", "error":{"message":"secret"}}}}),
    )
    .unwrap();
    assert_eq!(end["observedActiveTurns"], 0);
    assert_eq!(end["turnStatus"], "interrupted");
    assert_eq!(end["receivedFrames"], 1);
    assert_eq!(end["queuedFrames"], 2);
    assert_eq!(end["startedTurns"], 1);
    assert_eq!(end["completedTurns"], 1);
    assert!(!start.to_string().contains("secret"));
    assert!(!end.to_string().contains("secret"));
}

#[test]
fn malformed_ids_error_messages_labels_and_paths_never_enter_logs() {
    let mut state = SessionDiagnostics::new(4);
    for id in [
        "/Users/private/account-token",
        "agent label",
        "0001",
        "18446744073709551616",
        "01A12F23-9D7D-7CA0-8E55-5C54AE8379FD",
    ] {
        let event = observe(
            &mut state,
            json!({"method":"error","params":{
            "threadId":id,"turnId":id,"willRetry":false,
            "error":{"message":"secret request body","additionalDetails":"private token"}}}),
        )
        .unwrap();
        assert!(event.get("threadId").is_none());
        assert!(event.get("turnId").is_none());
        assert_eq!(event["willRetry"], false);
        assert!(!event.to_string().contains(id));
        assert!(!event.to_string().contains("secret"));
    }
    assert!(
        observe(
            &mut state,
            json!({"method":"arbitrary-private-method","params":{"prompt":"secret"}})
        )
        .is_none()
    );
    let numeric = observe(
        &mut state,
        json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":"42"}}}),
    )
    .unwrap();
    assert_eq!(numeric["turnId"], "42");
}

#[tokio::test]
async fn stderr_is_drained_with_bounded_storage_and_never_rendered() {
    let bytes = b"private token\nrequest body\n/Users/private/path\n".repeat(20_000);
    let counts = diagnostics::drain_stderr(bytes.as_slice()).await;
    assert_eq!(counts.bytes, bytes.len() as u64);
    assert!(counts.chunks > 1);
    assert!(!counts.read_failed);
    assert!(counts.complete);
    let record = SessionDiagnostics::new(2).end(Cause::ChildEof, &counts, Some("success"));
    assert_eq!(record["stderrBytes"], bytes.len() as u64);
    assert!(!record.to_string().contains("private"));
    assert!(!record.to_string().contains("request body"));
}

#[tokio::test]
async fn eof_and_fixed_frame_errors_have_safe_distinct_categories() {
    let mut clean = FrameReader::new(BufReader::new(&b"{}\n"[..]));
    assert_eq!(clean.next().await.unwrap().unwrap(), b"{}");
    assert!(clean.next().await.unwrap().is_none());
    let mut truncated = FrameReader::new(BufReader::new(&b"{private"[..]));
    assert_eq!(
        diagnostics::frame_cause(&truncated.next().await.unwrap_err()),
        Cause::FrameIncomplete
    );
    let bytes = vec![b'x'; MAX_FRAME + 1];
    let mut oversized = FrameReader::new(BufReader::new(bytes.as_slice()));
    assert_eq!(
        diagnostics::frame_cause(&oversized.next().await.unwrap_err()),
        Cause::FrameOversized
    );
    assert_eq!(
        diagnostics::frame_cause(&io::Error::other("private OS path")),
        Cause::FrameIo
    );
    let record = diagnostics::record("session_ended", 9, Cause::FrameIo);
    assert!(!record.to_string().contains("private"));
}

#[tokio::test]
async fn partial_frame_cancellation_does_not_invent_a_completed_turn() {
    let (mut writer, reader) = tokio::io::duplex(64);
    let mut frames = FrameReader::new(BufReader::new(reader));
    writer.write_all(b"{\"method\":").await.unwrap();
    let stop = CancellationToken::new();
    stop.cancel();
    let cause = tokio::select! {
        biased;
        _ = stop.cancelled() => Cause::Cancelled,
        _ = frames.next() => panic!("cancelled session read unexpectedly won"),
    };
    let mut state = SessionDiagnostics::new(3);
    observe(
        &mut state,
        json!({"method":"turn/started","params":{"threadId":THREAD,"turn":{"id":TURN}}}),
    );
    let end = state.end(cause, &Default::default(), None);
    assert_eq!(end["cause"], "cancelled");
    assert_eq!(end["observedActiveTurns"], 1);
    assert_eq!(end["completedTurns"], 0);
}

#[tokio::test]
async fn full_and_closed_queues_cancel_only_their_owner() {
    let (writer, mut reader) = mpsc::channel::<Value>(1);
    let token = CancellationToken::new();
    cancel_queue_error(
        ConnectionId(7),
        "session_queue_failed",
        writer.try_send(json!({})),
        &token,
    );
    assert!(!token.is_cancelled());
    cancel_queue_error(
        ConnectionId(7),
        "session_queue_failed",
        writer.try_send(json!({"private":"secret"})),
        &token,
    );
    assert!(token.is_cancelled());
    reader.recv().await.unwrap();
    drop(reader);
    let token = CancellationToken::new();
    cancel_queue_error(
        ConnectionId(7),
        "session_queue_failed",
        writer.try_send(json!({})),
        &token,
    );
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn old_task_completion_cannot_remove_replacement_connection() {
    let old = tokio::spawn(std::future::pending::<()>());
    let replacement = tokio::spawn(std::future::pending::<()>());
    let (writer, _reader) = mpsc::channel(1);
    let token = CancellationToken::new();
    let mut sessions = HashMap::from([(
        ConnectionId(12),
        SessionEntry {
            writer,
            stop: token.clone(),
            task: replacement.id(),
        },
    )]);
    finish_session(&mut sessions, ConnectionId(12), old.id());
    assert_eq!(sessions.len(), 1);
    assert!(!token.is_cancelled());
    finish_session(&mut sessions, ConnectionId(12), replacement.id());
    assert!(sessions.is_empty());
    assert!(token.is_cancelled());
    old.abort();
    replacement.abort();
    let _ = old.await;
    let _ = replacement.await;
}

#[tokio::test]
async fn panic_join_keeps_task_identity_for_owner_cleanup() {
    let mut tasks = tokio::task::JoinSet::new();
    let task = tasks.spawn(async {
        panic!("test panic");
    });
    let (writer, _reader) = mpsc::channel(1);
    let token = CancellationToken::new();
    let mut sessions = HashMap::from([(
        ConnectionId(13),
        SessionEntry {
            writer,
            stop: token.clone(),
            task: task.id(),
        },
    )]);
    let error = tasks.join_next_with_id().await.unwrap().unwrap_err();
    assert!(error.is_panic());
    assert_eq!(error.id(), task.id());
    finish_session(&mut sessions, ConnectionId(13), error.id());
    assert!(sessions.is_empty());
    assert!(token.is_cancelled());
}
