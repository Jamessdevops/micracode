use core_persistence::{DomainEvent, EventStore};

#[test]
fn append_then_read_returns_events_in_order_with_monotonic_seq() {
    let store = EventStore::open_in_memory().unwrap();

    let last = store
        .append(vec![
            DomainEvent::new("session.started", serde_json::json!({"id": "s1"})),
            DomainEvent::new("turn.created", serde_json::json!({"n": 1})),
        ])
        .unwrap();
    assert_eq!(last, 2, "append returns the latest cursor");

    let events = store.read_from(0).unwrap();
    assert_eq!(events.len(), 2);

    assert_eq!(events[0].seq, 1);
    assert_eq!(events[0].kind, "session.started");
    assert_eq!(events[0].payload, serde_json::json!({"id": "s1"}));

    assert_eq!(events[1].seq, 2);
    assert_eq!(events[1].kind, "turn.created");
}

#[test]
fn read_from_cursor_returns_only_events_after_it() {
    let store = EventStore::open_in_memory().unwrap();
    store
        .append(vec![
            DomainEvent::new("a", serde_json::json!({})),
            DomainEvent::new("b", serde_json::json!({})),
            DomainEvent::new("c", serde_json::json!({})),
        ])
        .unwrap();

    let tail = store.read_from(1).unwrap();
    let kinds: Vec<&str> = tail.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, vec!["b", "c"]);
    assert_eq!(tail[0].seq, 2);

    // A cursor at the head returns nothing.
    assert!(store.read_from(3).unwrap().is_empty());
}

#[test]
fn log_survives_reopen_and_seq_stays_monotonic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.db");

    {
        let store = EventStore::open(&path).unwrap();
        store
            .append(vec![DomainEvent::new("first", serde_json::json!({}))])
            .unwrap();
    } // store dropped — simulates app shutdown

    // Reopen the same file: the log rehydrates from disk.
    let store = EventStore::open(&path).unwrap();
    let replayed = store.read_from(0).unwrap();
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].kind, "first");

    // New appends continue the sequence rather than restarting at 1.
    let last = store
        .append(vec![DomainEvent::new("second", serde_json::json!({}))])
        .unwrap();
    assert_eq!(last, 2, "seq is monotonic across reopen");
}

#[test]
fn subscribe_delivers_newly_appended_events_in_order() {
    let store = EventStore::open_in_memory().unwrap();
    let mut rx = store.subscribe();

    store
        .append(vec![
            DomainEvent::new("one", serde_json::json!({})),
            DomainEvent::new("two", serde_json::json!({})),
        ])
        .unwrap();

    let first = rx.try_recv().unwrap();
    assert_eq!(first.seq, 1);
    assert_eq!(first.kind, "one");

    let second = rx.try_recv().unwrap();
    assert_eq!(second.seq, 2);
    assert_eq!(second.kind, "two");

    // A subscriber created after the append misses past events (hot stream only).
    let mut late = store.subscribe();
    assert!(late.try_recv().is_err());
}
