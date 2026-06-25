//! Integration test for [`ClaudeDriver`] against a mock subprocess.
//!
//! No real `claude` binary is available in CI (or on this machine), so the
//! driver's `program` is pointed at a small shell script that speaks the same
//! `stream-json`-over-stdio protocol: read a submission on stdin, emit canned
//! events on stdout. This exercises the full Claude path — spawn → write turn →
//! frame stdout → normalize through [`ClaudeAdapter`](core_provider::ClaudeAdapter)
//! — the mirror of the Codex mock-subprocess fixture (PRD §12). Unix-only.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;

use core_provider::{ClaudeDriver, Harness, ProviderDriver, ProviderEvent, SessionOptions};

/// Write an executable mock-`claude` script that emits a fixed stream-json
/// transcript after reading the first submission line, then exits so stdout
/// reaches EOF and the driver's pump terminates.
fn write_mock_claude(dir: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join("mock-claude.sh");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env bash
# Ignore the headless flags; read the first user message, then reply.
read -r _submission
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-mock-1","tools":["Bash"]}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi from claude"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"hi from claude","is_error":false,"session_id":"claude-mock-1"}'
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

#[tokio::test]
async fn drives_a_turn_and_normalizes_the_stream_json_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let script = write_mock_claude(dir.path());

    let driver = ClaudeDriver::with_program(script);
    let mut session = driver
        .start_session(SessionOptions {
            workspace: dir.path().to_path_buf(),
            model: None,
            resume: None,
            harness: Harness::Claude,
            permission: Default::default(),
        })
        .await
        .expect("session starts");

    session.handle.send_turn("hello").await.expect("turn sent");

    let mut events = Vec::new();
    while let Some(ev) = session.recv().await {
        events.push(ev);
    }

    assert_eq!(
        events,
        vec![
            ProviderEvent::SessionStarted {
                session_id: "claude-mock-1".into()
            },
            ProviderEvent::AssistantText {
                text: "hi from claude".into()
            },
            ProviderEvent::TurnCompleted {
                result: Some("hi from claude".into()),
                is_error: false,
            },
        ]
    );
}
