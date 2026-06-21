//! Terminal + preview slice for the Micracode Rust core (PRD FR7, P6).
//!
//! Two phase-2 capabilities the UI needs once a session is producing code:
//!
//! - **[`Terminal`]** — a PTY-backed shell session via `portable-pty`. The
//!   pseudo-terminal's output is read on a dedicated thread, buffered into a
//!   bounded scrollback, and fanned out over a `broadcast` channel so any
//!   number of viewers (and reconnecting ones) can follow along. Input,
//!   resize, and teardown are routed back to the child.
//! - **[`PreviewServer`]** — spawns a project's dev server (e.g. `npm run dev`)
//!   and discovers the port it comes up on by scanning, exposing a live
//!   [`PreviewStatus`] the UI can render as a preview pane.
//!
//! Both are deliberately *primitives*: they own one child each and know nothing
//! about ids, projects, or transports. The keyed managers that track many of
//! them live in the wiring layer (`desktop/api`), mirroring how
//! [`core_provider`] supplies a `CodexDriver` while `ProviderManager` owns the
//! session map.

mod preview;
mod terminal;

pub use preview::{PreviewError, PreviewOptions, PreviewServer, PreviewStatus};
pub use terminal::{Terminal, TerminalError, TerminalOptions, TerminalOutput};
