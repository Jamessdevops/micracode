//! Background reactors + the runtime receipt bus (PRD FR3).
//!
//! The engine ([`crate::Engine`]) is the *command* side: it turns commands into
//! durable events. Some of that work, though, must happen off the request path —
//! capturing a checkpoint after a turn, finalizing a diff, deleting a thread.
//! That is what a [`Reactor`] is: a single-writer queue (one `tokio::spawn` +
//! one `mpsc`) that processes jobs of one concern serially, so their effects
//! never reorder (PRD Risks — "single-writer queues per concern").
//!
//! When a job finishes the reactor publishes a [`RuntimeReceipt`] on the
//! [`ReceiptBus`]. Receipts are how the rest of the system — and the tests —
//! observe that asynchronous work has *settled*: instead of sleeping and hoping,
//! a caller subscribes to the bus and waits for the receipt it cares about, or
//! calls [`Reactor::drain_to_idle`] to block until the whole queue is empty.
//! This is the "deterministic drain-to-idle" the PRD makes a P4 exit criterion.

use std::future::Future;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{mpsc, watch};

/// Ring-buffer capacity for the receipt broadcast. Subscribers that fall behind
/// get a `Lagged` error and can resync; receipts are advisory, not the log.
const RECEIPT_BUS_CAPACITY: usize = 1024;

/// A typed completion signal emitted when a unit of background work settles.
///
/// These exist purely for *idle detection* — they carry just enough identity to
/// correlate a receipt with the work that produced it. The durable record of
/// what happened is always the event log, never a receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeReceipt {
    /// A per-turn checkpoint snapshot was taken (or skipped, if `checkpoint_id`
    /// is `None` because the turn changed nothing).
    CheckpointCaptured {
        session_id: Option<String>,
        checkpoint_id: Option<String>,
    },
    /// The working-tree diff for a turn has been finalized and is safe to read.
    DiffFinalized { session_id: Option<String> },
    /// A turn is fully settled: its output is in the log and its checkpoint (if
    /// any) is captured. The signal tests/orchestration wait on for idle.
    TurnQuiescent { session_id: String },
    /// A thread's deletion has been fully processed.
    ThreadDeleted { thread_id: String },
}

/// Broadcast channel of [`RuntimeReceipt`]s. Clone freely; every clone shares
/// the same channel, and each [`subscribe`](ReceiptBus::subscribe) is an
/// independent receiver.
#[derive(Clone)]
pub struct ReceiptBus {
    tx: tokio::sync::broadcast::Sender<RuntimeReceipt>,
}

impl ReceiptBus {
    pub fn new() -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(RECEIPT_BUS_CAPACITY);
        ReceiptBus { tx }
    }

    /// Subscribe to receipts emitted *after* this call.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<RuntimeReceipt> {
        self.tx.subscribe()
    }

    /// Publish a receipt. A bus with no live subscribers is fine — the send
    /// error is ignored, exactly like the event store's hot stream.
    pub fn emit(&self, receipt: RuntimeReceipt) {
        let _ = self.tx.send(receipt);
    }
}

impl Default for ReceiptBus {
    fn default() -> Self {
        ReceiptBus::new()
    }
}

/// Tracks how many jobs a reactor has accepted but not yet finished, and lets
/// callers await the transition to zero. Backed by a `watch` channel so the
/// latest count is always retained — there is no lost-wakeup race between
/// checking the count and awaiting a change.
struct IdleTracker {
    pending: watch::Sender<usize>,
}

impl IdleTracker {
    fn new() -> Self {
        let (pending, _) = watch::channel(0);
        IdleTracker { pending }
    }

    fn inc(&self) {
        self.pending.send_modify(|n| *n += 1);
    }

    fn dec(&self) {
        self.pending.send_modify(|n| *n -= 1);
    }

    fn get(&self) -> usize {
        *self.pending.borrow()
    }

    fn subscribe(&self) -> watch::Receiver<usize> {
        self.pending.subscribe()
    }
}

/// A single-writer background worker over jobs of type `J`.
///
/// Jobs are processed strictly in enqueue order on one task. The handler is
/// `async`, so it can offload blocking work (e.g. Git I/O) onto
/// `spawn_blocking` while the reactor itself stays cheap. Whatever receipts the
/// handler returns are published on the [`ReceiptBus`] the reactor was built
/// with, in order.
pub struct Reactor<J> {
    tx: mpsc::UnboundedSender<J>,
    idle: Arc<IdleTracker>,
}

// Manual `Clone` so a `Reactor` is shareable regardless of whether `J: Clone`
// (the job type is moved through the channel, never cloned). `#[derive(Clone)]`
// would wrongly require `J: Clone`.
impl<J> Clone for Reactor<J> {
    fn clone(&self) -> Self {
        Reactor {
            tx: self.tx.clone(),
            idle: Arc::clone(&self.idle),
        }
    }
}

impl<J: Send + 'static> Reactor<J> {
    /// Spawn the worker task and return a handle for enqueuing jobs.
    ///
    /// Must be called from within a Tokio runtime. The handler runs once per
    /// job, in order; its returned receipts are emitted on `bus`.
    pub fn spawn<F, Fut>(bus: ReceiptBus, handler: F) -> Self
    where
        F: Fn(J) -> Fut + Send + 'static,
        Fut: Future<Output = Vec<RuntimeReceipt>> + Send + 'static,
    {
        let (tx, mut rx) = mpsc::unbounded_channel::<J>();
        let idle = Arc::new(IdleTracker::new());
        let task_idle = Arc::clone(&idle);

        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                for receipt in handler(job).await {
                    bus.emit(receipt);
                }
                // Decrement only after the receipts are published, so a caller
                // woken by `drain_to_idle` is guaranteed to have already seen
                // them on the bus.
                task_idle.dec();
            }
        });

        Reactor { tx, idle }
    }

    /// Enqueue a job. Returns `false` if the worker has stopped (channel
    /// closed), in which case the job is dropped and the pending count is not
    /// affected.
    pub fn enqueue(&self, job: J) -> bool {
        // Count the job as pending *before* sending so a `drain_to_idle` racing
        // the enqueue can never observe a spurious zero.
        self.idle.inc();
        if self.tx.send(job).is_err() {
            self.idle.dec();
            return false;
        }
        true
    }

    /// Number of jobs accepted but not yet finished.
    pub fn pending(&self) -> usize {
        self.idle.get()
    }

    /// Resolve once the reactor has no jobs left to process. If new jobs are
    /// enqueued while draining, it waits for those too — it returns at the first
    /// moment the queue is observed empty.
    pub async fn drain_to_idle(&self) {
        let mut rx = self.idle.subscribe();
        loop {
            if *rx.borrow_and_update() == 0 {
                return;
            }
            // `changed()` errors only if the sender is dropped, which cannot
            // happen while we hold a `Reactor` (it owns the sender).
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn drain_to_idle_waits_for_all_jobs_then_returns() {
        let bus = ReceiptBus::new();
        let done = Arc::new(AtomicUsize::new(0));
        let task_done = Arc::clone(&done);

        let reactor = Reactor::spawn(bus, move |n: u64| {
            let task_done = Arc::clone(&task_done);
            async move {
                // Stagger completion so draining can't trivially win immediately.
                tokio::time::sleep(Duration::from_millis(10 * n)).await;
                task_done.fetch_add(1, Ordering::SeqCst);
                vec![RuntimeReceipt::TurnQuiescent {
                    session_id: format!("job-{n}"),
                }]
            }
        });

        for n in 1..=5 {
            assert!(reactor.enqueue(n));
        }
        assert!(reactor.pending() > 0);

        reactor.drain_to_idle().await;
        assert_eq!(reactor.pending(), 0);
        assert_eq!(done.load(Ordering::SeqCst), 5, "every job ran before idle");
    }

    #[tokio::test]
    async fn receipts_are_emitted_in_enqueue_order() {
        let bus = ReceiptBus::new();
        let mut rx = bus.subscribe();
        let reactor = Reactor::spawn(bus.clone(), |n: u64| async move {
            vec![RuntimeReceipt::ThreadDeleted {
                thread_id: n.to_string(),
            }]
        });

        for n in 0..4 {
            reactor.enqueue(n);
        }
        reactor.drain_to_idle().await;

        let mut seen = Vec::new();
        for _ in 0..4 {
            if let Ok(RuntimeReceipt::ThreadDeleted { thread_id }) = rx.recv().await {
                seen.push(thread_id);
            }
        }
        assert_eq!(seen, vec!["0", "1", "2", "3"], "single-writer preserves order");
    }

    #[tokio::test]
    async fn jobs_of_one_concern_never_overlap() {
        // A reactor is a *single* writer: two jobs must not run concurrently.
        let bus = ReceiptBus::new();
        let in_flight = Arc::new(Mutex::new(0usize));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let task_in_flight = Arc::clone(&in_flight);
        let task_max = Arc::clone(&max_seen);

        let reactor = Reactor::spawn(bus, move |_n: u64| {
            let in_flight = Arc::clone(&task_in_flight);
            let max = Arc::clone(&task_max);
            async move {
                {
                    let mut g = in_flight.lock().await;
                    *g += 1;
                    max.fetch_max(*g, Ordering::SeqCst);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
                *in_flight.lock().await -= 1;
                vec![]
            }
        });

        for n in 0..10 {
            reactor.enqueue(n);
        }
        reactor.drain_to_idle().await;
        assert_eq!(max_seen.load(Ordering::SeqCst), 1, "at most one job at a time");
    }
}
