//! The provider harness: the one place every Codex-vs-Claude difference lives.
//!
//! Both supported agents are subprocesses driven over framed stdio, differing
//! only in three things, all captured here:
//!
//! 1. **how they're launched** — [`Harness::command_args`];
//! 2. **how a turn / interrupt / shutdown is framed on stdin** —
//!    [`Harness::encode_turn`] / [`encode_interrupt`](Harness::encode_interrupt)
//!    / [`encode_shutdown`](Harness::encode_shutdown);
//! 3. **how their native events normalize** — [`Harness::normalize`].
//!
//! The rest of the system ([`driver`](crate::driver), the API) is harness-blind:
//! it carries a `Harness` value, builds a command from it, and pumps stdout
//! through it. Adding a third agent means another arm here, not new plumbing —
//! the "thin internal seam so providers *can* be added" the PRD calls for (§4).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::adapter::CodexAdapter;
use crate::claude_adapter::ClaudeAdapter;
use crate::driver::SessionOptions;
use crate::event::ProviderEvent;

/// Which agent CLI backs a session. Selected per session (PRD FR1, §4).
///
/// Serializes as `"codex"` / `"claude"` — the token the HTTP layer accepts on
/// `POST /v1/sessions` and persists in `session.start_requested` so a resumed
/// session re-launches the same agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    /// The Codex CLI in `proto` submission/event-queue mode.
    #[default]
    Codex,
    /// The Claude Code CLI in `stream-json` headless mode.
    Claude,
}

impl Harness {
    /// Parse the wire token, falling back to the default for anything unknown so
    /// a stale or absent value never wedges a session.
    pub fn from_token(token: Option<&str>) -> Self {
        match token.map(str::trim) {
            Some("claude") => Harness::Claude,
            _ => Harness::Codex,
        }
    }

    /// The wire token (`"codex"` / `"claude"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Harness::Codex => "codex",
            Harness::Claude => "claude",
        }
    }

    /// The default executable name when no explicit program is configured.
    pub fn default_program(self) -> &'static str {
        match self {
            Harness::Codex => "codex",
            Harness::Claude => "claude",
        }
    }

    /// Map a permission mode onto this harness's launch flags (PRD FR1). Both
    /// agents run headless — nothing can answer an interactive approval prompt —
    /// so every mode resolves to non-blocking flags: Claude uses
    /// `--permission-mode <mode>` (or the dedicated `--dangerously-skip-permissions`
    /// for bypass), and Codex keeps `approval_policy="never"` while varying the
    /// sandbox tier. Appended to `command_args`.
    fn permission_args(self, permission: PermissionMode) -> Vec<String> {
        match self {
            Harness::Claude => match permission {
                // The one the user calls out: full autonomy, no checks.
                PermissionMode::BypassPermissions => {
                    vec!["--dangerously-skip-permissions".into()]
                }
                mode => vec!["--permission-mode".into(), mode.as_str().into()],
            },
            Harness::Codex => {
                // Codex `proto` can't answer approvals headlessly, so approval
                // stays "never" and the *sandbox* carries the permission tier.
                let sandbox = match permission {
                    PermissionMode::Default | PermissionMode::Plan => "read-only",
                    PermissionMode::AcceptEdits => "workspace-write",
                    PermissionMode::BypassPermissions => "danger-full-access",
                };
                vec![
                    "-c".into(),
                    "approval_policy=\"never\"".into(),
                    "-c".into(),
                    format!("sandbox_mode=\"{sandbox}\""),
                ]
            }
        }
    }

    /// The full argument vector (after the program name) for one session.
    ///
    /// Both default to fully autonomous, headless operation — the agent edits
    /// within its workspace without blocking on interactive approval prompts,
    /// which the queue/stream model cannot answer. Callers can prepend stricter
    /// policy via the driver's `extra_args`.
    pub fn command_args(self, opts: &SessionOptions) -> Vec<String> {
        match self {
            Harness::Codex => {
                let mut args = vec!["proto".into()];
                // approval/sandbox flags come from the permission mode.
                args.extend(self.permission_args(opts.permission));
                if let Some(model) = &opts.model {
                    args.push("-c".into());
                    args.push(format!("model=\"{model}\""));
                }
                // Resume by Codex's own session id: it replays that rollout so
                // turns continue the conversation rather than starting fresh.
                if let Some(resume) = &opts.resume {
                    args.push("-c".into());
                    args.push(format!("experimental_resume=\"{resume}\""));
                }
                args
            }
            Harness::Claude => {
                // `-p` headless print mode + stream-json on both ends keeps the
                // process alive as a multi-turn submission queue, mirroring how
                // `codex proto` is driven. `--verbose` is required for
                // stream-json output under `-p`.
                let mut args = vec![
                    "-p".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--input-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                ];
                // Permission mode → `--dangerously-skip-permissions` (bypass) or
                // `--permission-mode <mode>` (every other mode).
                args.extend(self.permission_args(opts.permission));
                if let Some(model) = &opts.model {
                    args.push("--model".into());
                    args.push(model.clone());
                }
                // Resume by Claude's own session id (`--resume <id>`).
                if let Some(resume) = &opts.resume {
                    args.push("--resume".into());
                    args.push(resume.clone());
                }
                args
            }
        }
    }

    /// Frame a user turn as one stdin line (no trailing newline).
    ///
    /// `submission_id` is a per-session monotonic id; only Codex's protocol
    /// echoes it back, but it must be present and unique on every Codex
    /// submission. Claude's stream-json input carries no such id.
    pub fn encode_turn(self, submission_id: &str, text: &str) -> String {
        match self {
            Harness::Codex => json!({
                "id": submission_id,
                "op": { "type": "user_input", "items": [{ "type": "text", "text": text }] },
            })
            .to_string(),
            Harness::Claude => json!({
                "type": "user",
                "message": { "role": "user", "content": text },
            })
            .to_string(),
        }
    }

    /// Frame an interrupt of the in-flight turn, if the protocol has one inline.
    /// `None` means the harness offers no stdin interrupt (Claude's stream-json
    /// input has none); the caller falls back to stopping the session.
    pub fn encode_interrupt(self, submission_id: &str) -> Option<String> {
        match self {
            Harness::Codex => Some(
                json!({ "id": submission_id, "op": { "type": "interrupt" } }).to_string(),
            ),
            Harness::Claude => None,
        }
    }

    /// Frame a graceful-shutdown submission, if any. `None` means closing stdin
    /// (EOF) is the shutdown signal (Claude).
    pub fn encode_shutdown(self, submission_id: &str) -> Option<String> {
        match self {
            Harness::Codex => Some(
                json!({ "id": submission_id, "op": { "type": "shutdown" } }).to_string(),
            ),
            Harness::Claude => None,
        }
    }

    /// Normalize one native event line into canonical [`ProviderEvent`]s.
    pub fn normalize(self, value: &Value) -> Vec<ProviderEvent> {
        match self {
            Harness::Codex => CodexAdapter::normalize(value),
            Harness::Claude => ClaudeAdapter::normalize(value),
        }
    }
}

/// How much autonomy the agent is granted over its workspace — the user-facing
/// "permission mode", chosen per session and mapped onto each harness's own
/// permission/sandbox flags by [`Harness::permission_args`].
///
/// The variants mirror Claude Code's `--permission-mode` values so the wire
/// tokens line up: `default`, `plan`, `acceptEdits`, `bypassPermissions`. The
/// HTTP layer accepts the token on `POST /v1/sessions` and persists it in
/// `session.start_requested`, so a resumed session re-applies the same mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Standard prompting. Headless (nothing answers prompts), so tools that
    /// would need approval are effectively denied — safe but limited.
    Default,
    /// Planning only: the agent reads and proposes but does not modify files.
    Plan,
    /// Auto-accept file edits within the workspace; other actions still gated.
    AcceptEdits,
    /// Bypass every permission check (`claude --dangerously-skip-permissions`;
    /// Codex `sandbox_mode="danger-full-access"`). Fully autonomous. The default,
    /// preserving the prior always-skip behavior so existing flows keep working.
    #[default]
    BypassPermissions,
}

impl PermissionMode {
    /// Parse the wire token, falling back to the default for anything unknown so
    /// a stale or absent value never wedges a session.
    pub fn from_token(token: Option<&str>) -> Self {
        match token.map(str::trim) {
            Some("default") => PermissionMode::Default,
            Some("plan") => PermissionMode::Plan,
            Some("acceptEdits") => PermissionMode::AcceptEdits,
            _ => PermissionMode::BypassPermissions,
        }
    }

    /// The wire/CLI token (`default` / `plan` / `acceptEdits` / `bypassPermissions`).
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Plan => "plan",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn opts() -> SessionOptions {
        SessionOptions {
            workspace: PathBuf::from("/work"),
            model: None,
            resume: None,
            harness: Harness::Codex,
            permission: PermissionMode::default(),
        }
    }

    #[test]
    fn token_round_trips_and_defaults_to_codex() {
        assert_eq!(Harness::from_token(Some("claude")), Harness::Claude);
        assert_eq!(Harness::from_token(Some("codex")), Harness::Codex);
        assert_eq!(Harness::from_token(Some("bogus")), Harness::Codex);
        assert_eq!(Harness::from_token(None), Harness::Codex);
        assert_eq!(Harness::Claude.as_str(), "claude");
        assert_eq!(Harness::default(), Harness::Codex);
    }

    #[test]
    fn codex_args_include_proto_and_resume() {
        let args = Harness::Codex.command_args(&SessionOptions {
            resume: Some("sess-1".into()),
            model: Some("o3".into()),
            ..opts()
        });
        assert_eq!(args[0], "proto");
        assert!(args.iter().any(|a| a == "model=\"o3\""));
        assert!(args.iter().any(|a| a == "experimental_resume=\"sess-1\""));
    }

    #[test]
    fn claude_args_request_stream_json_both_ends() {
        let args = Harness::Claude.command_args(&SessionOptions {
            resume: Some("sess-9".into()),
            model: Some("claude-opus-4-8".into()),
            harness: Harness::Claude,
            ..opts()
        });
        assert!(args.windows(2).any(|w| w == ["--output-format", "stream-json"]));
        assert!(args.windows(2).any(|w| w == ["--input-format", "stream-json"]));
        assert!(args.windows(2).any(|w| w == ["--model", "claude-opus-4-8"]));
        assert!(args.windows(2).any(|w| w == ["--resume", "sess-9"]));
    }

    #[test]
    fn turn_framing_differs_by_harness() {
        let codex: Value =
            serde_json::from_str(&Harness::Codex.encode_turn("0", "hi")).unwrap();
        assert_eq!(codex["op"]["type"], "user_input");
        assert_eq!(codex["id"], "0");

        let claude: Value =
            serde_json::from_str(&Harness::Claude.encode_turn("0", "hi")).unwrap();
        assert_eq!(claude["type"], "user");
        assert_eq!(claude["message"]["content"], "hi");
    }

    #[test]
    fn claude_has_no_inline_interrupt_or_shutdown() {
        assert!(Harness::Claude.encode_interrupt("0").is_none());
        assert!(Harness::Claude.encode_shutdown("0").is_none());
        assert!(Harness::Codex.encode_interrupt("0").is_some());
    }

    #[test]
    fn permission_token_round_trips_and_defaults_to_bypass() {
        assert_eq!(PermissionMode::from_token(Some("default")), PermissionMode::Default);
        assert_eq!(PermissionMode::from_token(Some("plan")), PermissionMode::Plan);
        assert_eq!(
            PermissionMode::from_token(Some("acceptEdits")),
            PermissionMode::AcceptEdits
        );
        assert_eq!(
            PermissionMode::from_token(Some("bypassPermissions")),
            PermissionMode::BypassPermissions
        );
        // Unknown / absent → bypass (the default), so a stale value never wedges.
        assert_eq!(PermissionMode::from_token(Some("bogus")), PermissionMode::BypassPermissions);
        assert_eq!(PermissionMode::from_token(None), PermissionMode::BypassPermissions);
        assert_eq!(PermissionMode::default(), PermissionMode::BypassPermissions);
    }

    #[test]
    fn claude_permission_mode_maps_to_flags() {
        let args = |p| {
            Harness::Claude.command_args(&SessionOptions {
                harness: Harness::Claude,
                permission: p,
                ..opts()
            })
        };
        // Bypass uses the dedicated dangerous flag, no --permission-mode.
        let bypass = args(PermissionMode::BypassPermissions);
        assert!(bypass.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!bypass.iter().any(|a| a == "--permission-mode"));
        // Every other mode uses --permission-mode <token> and never the dangerous flag.
        for (mode, token) in [
            (PermissionMode::Default, "default"),
            (PermissionMode::Plan, "plan"),
            (PermissionMode::AcceptEdits, "acceptEdits"),
        ] {
            let a = args(mode);
            assert!(a.windows(2).any(|w| w == ["--permission-mode", token]), "{token}: {a:?}");
            assert!(!a.iter().any(|x| x == "--dangerously-skip-permissions"));
        }
    }

    #[test]
    fn codex_permission_mode_maps_to_sandbox_tier() {
        let sandbox = |p| {
            Harness::Codex
                .command_args(&SessionOptions { permission: p, ..opts() })
                .join(" ")
        };
        assert!(sandbox(PermissionMode::Plan).contains("sandbox_mode=\"read-only\""));
        assert!(sandbox(PermissionMode::Default).contains("sandbox_mode=\"read-only\""));
        assert!(sandbox(PermissionMode::AcceptEdits).contains("sandbox_mode=\"workspace-write\""));
        assert!(sandbox(PermissionMode::BypassPermissions)
            .contains("sandbox_mode=\"danger-full-access\""));
        // Approval stays "never" regardless — nothing can answer prompts headlessly.
        assert!(sandbox(PermissionMode::Default).contains("approval_policy=\"never\""));
    }
}
