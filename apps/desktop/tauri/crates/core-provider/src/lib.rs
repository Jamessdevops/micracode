//! Provider slice for the Micracode Rust core (PRD FR1).
//!
//! An agent CLI is spawned as a subprocess — either the Codex CLI (`codex proto`
//! submission/event-queue mode) or the Claude Code CLI (`claude … stream-json`)
//! — its native events normalized into a canonical [`ProviderEvent`] model, and
//! its turns driven over framed stdio. Which agent backs a session is chosen per
//! session via [`Harness`] (PRD §4); all the per-agent differences live there,
//! so both [`CodexDriver`] and [`ClaudeDriver`] hand back the same [`Session`].

mod adapter;
mod claude_adapter;
mod driver;
mod event;
mod harness;

pub use adapter::CodexAdapter;
pub use claude_adapter::ClaudeAdapter;
pub use driver::{
    ClaudeConfig, ClaudeDriver, CodexConfig, CodexDriver, ProviderDriver, ProviderError, Session,
    SessionHandle, SessionOptions,
};
pub use event::ProviderEvent;
pub use harness::{Harness, PermissionMode};
