//! Event-sourced command/event engine (PRD FR2).
//!
//! Commands are dispatched through a serialized path: each carries an
//! idempotency `id`, a decider turns it into domain events, those events are
//! appended to the [`EventStore`], and a [`Receipt`] records the outcome.
//! Re-dispatching a command with a previously seen id returns the cached
//! receipt without re-applying it (dedupe replays).

use std::collections::HashMap;
use std::sync::Mutex;

use core_persistence::{DomainEvent, EventStore, StoreError};
use serde_json::Value;

mod runtime;
pub use runtime::{Reactor, ReceiptBus, RuntimeReceipt};

/// A typed command to dispatch. `id` is the idempotency key.
#[derive(Debug, Clone)]
pub struct Command {
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

/// Outcome of dispatching a command.
#[derive(Debug, Clone, PartialEq, serde::Serialize, ts_rs::TS)]
pub struct Receipt {
    pub command_id: String,
    /// Sequence numbers of the events appended by this command.
    #[ts(type = "Array<number>")]
    pub events: Vec<u64>,
    /// True when this dispatch was a replay served from the dedupe cache.
    pub deduped: bool,
}

/// A command the decider refused to accept: it failed validation and produced
/// no events. Surfaced to the caller so the transport can answer with a client
/// error (4xx) rather than recording garbage (PRD FR2 — validate commands).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct DeciderError(pub String);

impl DeciderError {
    pub fn new(message: impl Into<String>) -> Self {
        DeciderError(message.into())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The command was rejected by the decider; nothing was appended.
    #[error("command rejected: {0}")]
    Rejected(#[from] DeciderError),
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// Turns a command into the domain events it produces, or rejects it. The
/// decider is the single place command shape/intent is validated (PRD FR2);
/// keeping it pure (no side effects) is what makes the log replayable.
type Decider =
    Box<dyn Fn(&Command) -> std::result::Result<Vec<DomainEvent>, DeciderError> + Send + Sync>;

/// Serialized event-sourced engine over an [`EventStore`].
pub struct Engine {
    store: EventStore,
    decider: Decider,
    /// Held across the whole of `dispatch` to serialize command processing and
    /// to guard the dedupe cache atomically with the append.
    receipts: Mutex<HashMap<String, Receipt>>,
}

impl Engine {
    pub fn new(
        store: EventStore,
        decider: impl Fn(&Command) -> std::result::Result<Vec<DomainEvent>, DeciderError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Engine {
            store,
            decider: Box::new(decider),
            receipts: Mutex::new(HashMap::new()),
        }
    }

    /// The underlying event store (for replay / projection rebuilds).
    pub fn store(&self) -> &EventStore {
        &self.store
    }

    /// Dispatch a command: decide its events, append them, and return a receipt.
    /// A command id seen before yields its cached receipt with `deduped = true`.
    /// A command the decider rejects yields [`EngineError::Rejected`] and is not
    /// recorded — re-dispatching it re-runs the decider rather than caching the
    /// rejection.
    pub fn dispatch(&self, command: Command) -> Result<Receipt> {
        let mut seen = self.receipts.lock().unwrap();
        if let Some(prior) = seen.get(&command.id) {
            return Ok(Receipt {
                deduped: true,
                ..prior.clone()
            });
        }

        let events = (self.decider)(&command)?;
        let count = events.len() as u64;
        let last = self.store.append(events)?;
        // Appends are contiguous, so the new events occupy `last-count+1 ..= last`.
        let seqs: Vec<u64> = if count == 0 {
            Vec::new()
        } else {
            (last - count + 1..=last).collect()
        };

        let receipt = Receipt {
            command_id: command.id.clone(),
            events: seqs,
            deduped: false,
        };
        seen.insert(command.id, receipt.clone());
        Ok(receipt)
    }
}
