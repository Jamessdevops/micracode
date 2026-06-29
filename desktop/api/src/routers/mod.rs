//! Route handlers, grouped to mirror the Python `routers/` package. Everything
//! is mounted under the `/v1` prefix by `main.rs`.

pub mod commands;
pub mod fs;
pub mod health;
pub mod models;
pub mod preview;
pub mod projects;
pub mod receipts;
pub mod sessions;
pub mod terminals;
pub mod threads;
pub mod vcs;

use std::sync::Arc;

use axum::Router;
use core_orchestration::Engine;

use crate::config::Config;
use crate::preview::PreviewManager;
use crate::projection::ProjectionHandle;
use crate::provider::ProviderManager;
use crate::storage::Storage;
use crate::terminal::TerminalManager;

/// Shared application state (the Rust analogue of the FastAPI `StorageDep`).
#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<Storage>,
    pub config: Arc<Config>,
    /// Event-sourced engine backing the `/v1/commands` + `/v1/events` surface.
    pub engine: Arc<Engine>,
    /// Codex provider sessions feeding the same event log (PRD FR1).
    pub provider: Arc<ProviderManager>,
    /// Read-model projection folded from the log (threads/turns/messages, FR2).
    pub projection: ProjectionHandle,
    /// PTY-backed terminal sessions (PRD FR7).
    pub terminals: Arc<TerminalManager>,
    /// Dev-server previews, one per project (PRD FR7).
    pub previews: Arc<PreviewManager>,
}

/// Build the combined `/v1` router.
pub fn api_router(state: AppState) -> Router {
    Router::new()
        .merge(health::router())
        .merge(models::router())
        .merge(projects::router())
        .merge(commands::router())
        .merge(fs::router())
        .merge(sessions::router())
        .merge(threads::router())
        .merge(receipts::router())
        .merge(vcs::router())
        .merge(terminals::router())
        .merge(preview::router())
        .with_state(state)
}
