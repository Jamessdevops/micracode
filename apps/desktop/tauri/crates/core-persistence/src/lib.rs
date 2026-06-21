//! Append-only event store for the Micracode Rust core.
//!
//! The event log is the source of truth (PRD FR4): domain events are appended
//! in order, each assigned a monotonic global `seq` (cursor), and projections
//! are rebuilt by replaying the log from a cursor.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value;
use tokio::sync::broadcast;

/// Capacity of the hot event stream's ring buffer. Slow subscribers that fall
/// behind get a `Lagged` error and must catch up via `read_from`.
const HOT_STREAM_CAPACITY: usize = 1024;

/// A domain event to append to the log. `seq` is assigned on append.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainEvent {
    pub kind: String,
    pub payload: Value,
}

impl DomainEvent {
    pub fn new(kind: impl Into<String>, payload: Value) -> Self {
        DomainEvent {
            kind: kind.into(),
            payload,
        }
    }
}

/// An event read back from the log, carrying its assigned global cursor.
#[derive(Debug, Clone, PartialEq, serde::Serialize, ts_rs::TS)]
pub struct StoredEvent {
    #[ts(type = "number")]
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Append-only, ordered event store backed by SQLite.
pub struct EventStore {
    conn: Mutex<Connection>,
    hot: broadcast::Sender<StoredEvent>,
}

impl EventStore {
    /// Open an in-memory store (tests).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::from_conn(conn)
    }

    /// Open a file-backed store, creating the schema if absent.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    fn from_conn(mut conn: Connection) -> Result<Self> {
        run_migrations(&mut conn)?;
        let (hot, _) = broadcast::channel(HOT_STREAM_CAPACITY);
        Ok(EventStore {
            conn: Mutex::new(conn),
            hot,
        })
    }

    /// The schema version this store is migrated to (0 if none applied). The
    /// log is the source of truth (PRD FR4); this is the schema the projections
    /// and event readers are written against.
    pub fn schema_version(&self) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        current_schema_version(&conn)
    }

    /// Subscribe to the hot stream of events appended after this call. Past
    /// events are not replayed here — use `read_from` to catch up first.
    pub fn subscribe(&self) -> broadcast::Receiver<StoredEvent> {
        self.hot.subscribe()
    }

    /// Append events in order, returning the latest cursor (`seq` of the last event).
    ///
    /// Events are committed atomically, then published to the hot stream in
    /// order so subscribers observe the same ordering as the persisted log.
    pub fn append(&self, events: Vec<DomainEvent>) -> Result<u64> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut stored = Vec::with_capacity(events.len());
        for event in events {
            let payload = serde_json::to_string(&event.payload)?;
            tx.execute(
                "INSERT INTO events (kind, payload) VALUES (?1, ?2)",
                rusqlite::params![event.kind, payload],
            )?;
            stored.push(StoredEvent {
                seq: tx.last_insert_rowid() as u64,
                kind: event.kind,
                payload: event.payload,
            });
        }
        tx.commit()?;

        let last = stored.last().map(|e| e.seq).unwrap_or(0);
        for event in stored {
            // Ignore send errors: a stream with no live subscribers is fine.
            let _ = self.hot.send(event);
        }
        Ok(last)
    }

    /// Replay events with `seq` strictly greater than `cursor`, in order.
    pub fn read_from(&self, cursor: u64) -> Result<Vec<StoredEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, kind, payload FROM events WHERE seq > ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([cursor], |row| {
            let seq: i64 = row.get(0)?;
            let kind: String = row.get(1)?;
            let payload: String = row.get(2)?;
            Ok((seq as u64, kind, payload))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (seq, kind, payload) = row?;
            out.push(StoredEvent {
                seq,
                kind,
                payload: serde_json::from_str(&payload)?,
            });
        }
        Ok(out)
    }
}

/// One forward-only schema migration. `version` is the monotonically increasing
/// migration number; `sql` is applied exactly once, in order, and its version
/// is then recorded in `schema_migrations`.
struct Migration {
    version: u32,
    sql: &'static str,
}

/// The ordered, forward-only migration set (PRD FR4). Append new migrations to
/// the end with the next version number; never edit or reorder an applied one.
const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    // `IF NOT EXISTS` so this is also a safe backfill for stores created before
    // `schema_migrations` existed: the table is already there, and we only need
    // to stamp the version. New stores create it here.
    sql: "CREATE TABLE IF NOT EXISTS events (
              seq     INTEGER PRIMARY KEY AUTOINCREMENT,
              kind    TEXT NOT NULL,
              payload TEXT NOT NULL
          );",
}];

/// The highest applied migration version (0 if the ledger is empty).
fn current_schema_version(conn: &Connection) -> Result<u32> {
    let version = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    Ok(version)
}

/// Apply every migration whose version is newer than the recorded ledger, in
/// order, each in its own transaction so a crash mid-upgrade leaves the store at
/// a clean, partially-migrated-but-consistent version (PRD: crash-safe schema
/// evolution). Idempotent: reopening a store applies nothing.
fn run_migrations(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )?;

    let current = current_schema_version(conn)?;
    for migration in MIGRATIONS {
        if migration.version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            [migration.version],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_store_is_migrated_to_the_latest_version() {
        let store = EventStore::open_in_memory().unwrap();
        let latest = MIGRATIONS.last().map(|m| m.version).unwrap_or(0);
        assert_eq!(store.schema_version().unwrap(), latest);
        // The migrated schema is usable: appends and replays round-trip.
        store
            .append(vec![DomainEvent::new("test.event", serde_json::json!({}))])
            .unwrap();
        assert_eq!(store.read_from(0).unwrap().len(), 1);
    }

    #[test]
    fn migrations_apply_once_and_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.db");

        {
            let store = EventStore::open(&path).unwrap();
            store
                .append(vec![DomainEvent::new("first", serde_json::json!({ "n": 1 }))])
                .unwrap();
        }

        // Reopening runs the migration runner again; it must be a no-op that
        // neither re-applies migrations nor disturbs the existing log.
        let reopened = EventStore::open(&path).unwrap();
        assert_eq!(
            reopened.schema_version().unwrap(),
            MIGRATIONS.last().unwrap().version
        );
        let log = reopened.read_from(0).unwrap();
        assert_eq!(log.len(), 1, "existing events survive a reopen");
        assert_eq!(log[0].kind, "first");

        // The ledger recorded each migration exactly once.
        let conn = reopened.conn.lock().unwrap();
        let rows: u32 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows as usize, MIGRATIONS.len());
    }
}
