//! Crash-recovery: the event log is the recovery anchor, and the projection
//! rebuilt from it is never corrupted by an abrupt mid-turn shutdown
//! (PRD §8 Reliability; P4 exit criterion).
//!
//! These tests drive the *real* persistence layer ([`EventStore`] over a file)
//! rather than a fake, and simulate a crash by dropping the store without any
//! graceful shutdown. Because every append commits its own SQLite transaction,
//! the durable log survives, and [`Projection::rebuild_from`] folds it back into
//! an identical read model.

use core_persistence::{DomainEvent, EventStore};
use core_projection::{Message, Projection, ThreadStatus, TurnStatus};
use serde_json::json;

/// Append the events the provider pump would write, the way it writes them.
fn user_turn(session_id: &str, text: &str) -> DomainEvent {
    DomainEvent::new(
        "provider.user_turn",
        json!({ "session_id": session_id, "text": text }),
    )
}

fn provider_event(session_id: &str, event: serde_json::Value) -> DomainEvent {
    let kind = format!("provider.{}", event["type"].as_str().unwrap());
    DomainEvent::new(kind, json!({ "session_id": session_id, "event": event }))
}

#[test]
fn projection_rebuilds_intact_after_a_mid_turn_crash() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("events.db");

    // --- Run 1: a turn that is interrupted mid-flight (no `turn_completed`). ---
    {
        let store = EventStore::open(&db).unwrap();
        store
            .append(vec![
                user_turn("s1", "refactor the parser"),
                provider_event("s1", json!({ "type": "session_started", "session_id": "claude-1" })),
                provider_event("s1", json!({ "type": "assistant_text", "text": "starting" })),
            ])
            .unwrap();
        // Drop the store here with no flush/close — the simulated crash. SQLite
        // has already committed each append, so the log is durable.
    }

    // --- Run 2: reopen from the same file and rebuild. ---
    let store = EventStore::open(&db).unwrap();
    let log = store.read_from(0).unwrap();
    assert_eq!(log.len(), 3, "every committed event survived the crash");

    let projection = Projection::rebuild_from(&log);
    let thread = projection.thread("s1").expect("thread recovered");

    // No corruption: the thread is still active, the interrupted turn is still
    // marked Running (not silently completed or lost), and its messages are the
    // exact prefix that was durably recorded.
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(thread.provider_session_id.as_deref(), Some("claude-1"));
    assert_eq!(thread.turns.len(), 1);
    assert_eq!(thread.turns[0].status, TurnStatus::Running);
    assert_eq!(
        thread.turns[0].messages,
        vec![
            Message::User { text: "refactor the parser".into() },
            Message::Assistant { text: "starting".into() },
        ]
    );

    // Recovery is clean enough to *continue*: completing the turn after restart
    // advances the same thread to a terminal state.
    store
        .append(vec![provider_event(
            "s1",
            json!({ "type": "turn_completed", "result": "done", "is_error": false }),
        )])
        .unwrap();
    let resumed = Projection::rebuild_from(&store.read_from(0).unwrap());
    assert_eq!(resumed.thread("s1").unwrap().turns[0].status, TurnStatus::Completed);
}

#[test]
fn rebuilding_the_same_log_twice_yields_the_same_model() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("events.db");

    let store = EventStore::open(&db).unwrap();
    store
        .append(vec![
            user_turn("s1", "hi"),
            provider_event("s1", json!({ "type": "assistant_text", "text": "hello" })),
            provider_event("s1", json!({ "type": "turn_completed", "result": "hello", "is_error": false })),
            user_turn("s2", "other session"),
        ])
        .unwrap();

    let log = store.read_from(0).unwrap();
    // Determinism is what makes the log a safe recovery anchor: folding it any
    // number of times produces byte-identical summaries.
    let a = Projection::rebuild_from(&log);
    let b = Projection::rebuild_from(&log);
    assert_eq!(a.cursor(), b.cursor());
    assert_eq!(
        serde_json::to_value(a.summaries()).unwrap(),
        serde_json::to_value(b.summaries()).unwrap(),
    );
    assert_eq!(a.summaries().len(), 2);
}
