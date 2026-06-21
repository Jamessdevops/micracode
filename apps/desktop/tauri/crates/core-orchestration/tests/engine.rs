use core_orchestration::{Command, DeciderError, Engine, EngineError};
use core_persistence::{DomainEvent, EventStore};

fn cmd(id: &str, kind: &str) -> Command {
    Command {
        id: id.into(),
        kind: kind.into(),
        payload: serde_json::json!({}),
    }
}

#[test]
fn dispatch_appends_decided_events_and_returns_receipt() {
    let store = EventStore::open_in_memory().unwrap();
    let engine = Engine::new(store, |cmd: &Command| {
        Ok(vec![DomainEvent::new(
            format!("{}.done", cmd.kind),
            cmd.payload.clone(),
        )])
    });

    let receipt = engine.dispatch(cmd("c1", "send_turn")).unwrap();

    assert_eq!(receipt.command_id, "c1");
    assert!(!receipt.deduped);
    assert_eq!(receipt.events, vec![1], "receipt carries appended event seqs");

    let log = engine.store().read_from(0).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].kind, "send_turn.done");
}

#[test]
fn redispatching_a_command_id_is_idempotent() {
    let store = EventStore::open_in_memory().unwrap();
    let engine = Engine::new(store, |_cmd: &Command| {
        Ok(vec![DomainEvent::new("applied", serde_json::json!({}))])
    });

    let first = engine.dispatch(cmd("dup", "x")).unwrap();
    assert!(!first.deduped);

    // Same id again: served from the dedupe cache, nothing re-appended.
    let second = engine.dispatch(cmd("dup", "x")).unwrap();
    assert!(second.deduped);
    assert_eq!(second.events, first.events, "same receipt is returned");

    let log = engine.store().read_from(0).unwrap();
    assert_eq!(log.len(), 1, "the command was applied exactly once");
}

#[test]
fn a_rejected_command_appends_nothing_and_is_not_cached() {
    let store = EventStore::open_in_memory().unwrap();
    // A decider that accepts "ok" and rejects everything else.
    let engine = Engine::new(store, |cmd: &Command| {
        if cmd.kind == "ok" {
            Ok(vec![DomainEvent::new("ok.done", serde_json::json!({}))])
        } else {
            Err(DeciderError::new("nope"))
        }
    });

    let err = engine.dispatch(cmd("c1", "bad")).unwrap_err();
    assert!(matches!(err, EngineError::Rejected(_)));
    assert_eq!(engine.store().read_from(0).unwrap().len(), 0);

    // The id was not cached: a later valid command can reuse it and still apply.
    let receipt = engine.dispatch(cmd("c1", "ok")).unwrap();
    assert!(!receipt.deduped);
    assert_eq!(engine.store().read_from(0).unwrap().len(), 1);
}
