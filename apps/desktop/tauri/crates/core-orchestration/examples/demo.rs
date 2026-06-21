//! Manual smoke test for the event-sourced core.
//!
//! Run it:
//!     cargo run -p core-orchestration --example demo
//!
//! It opens a real file-backed event store, dispatches a few commands through
//! the engine, then reopens the file to prove the log persists across restart.

use core_orchestration::{Command, Engine};
use core_persistence::{DomainEvent, EventStore};

fn main() {
    // A throwaway db file so you can run this repeatedly; delete it to reset.
    let db = std::env::temp_dir().join("micracode-demo-events.db");
    let _ = std::fs::remove_file(&db);
    println!("event log: {}\n", db.display());

    // The decider turns a command into the events it produces. The real engine
    // will have a Codex-driven decider; here it's a trivial echo.
    let store = EventStore::open(&db).expect("open store");
    let engine = Engine::new(store, |cmd: &Command| {
        Ok(vec![DomainEvent::new(
            format!("{}.accepted", cmd.kind),
            cmd.payload.clone(),
        )])
    });

    // --- dispatch two commands ---
    for (id, kind, text) in [
        ("cmd-1", "start_session", "open repo"),
        ("cmd-2", "send_turn", "fix the bug"),
    ] {
        let receipt = engine
            .dispatch(Command {
                id: id.into(),
                kind: kind.into(),
                payload: serde_json::json!({ "text": text }),
            })
            .expect("dispatch");
        println!(
            "dispatch {id:>6} ({kind})  -> events={:?} deduped={}",
            receipt.events, receipt.deduped
        );
    }

    // --- re-dispatch cmd-1: idempotent, nothing re-appended ---
    let again = engine
        .dispatch(Command {
            id: "cmd-1".into(),
            kind: "start_session".into(),
            payload: serde_json::json!({ "text": "open repo" }),
        })
        .expect("dispatch");
    println!(
        "re-dispatch cmd-1            -> events={:?} deduped={}  <- served from cache\n",
        again.events, again.deduped
    );

    // --- replay the whole log ---
    println!("replay from cursor 0:");
    for e in engine.store().read_from(0).expect("replay") {
        println!("  seq {} | {:<22} | {}", e.seq, e.kind, e.payload);
    }

    // --- prove persistence: reopen the file in a fresh store ---
    drop(engine);
    let reopened = EventStore::open(&db).expect("reopen");
    let count = reopened.read_from(0).expect("replay").len();
    println!("\nreopened the db file: {count} events rehydrated from disk");
}
