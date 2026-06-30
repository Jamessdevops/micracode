#!/usr/bin/env bash
# Minimal Codex `proto` mock: reads one submission line, then streams a
# session_configured + agent_message + task_complete, exactly like the
# backend's integration-test fixture. Exits after the turn (flushes stdout).
read -r _submission
printf '%s\n' '{"id":"0","msg":{"type":"session_configured","session_id":"mock-codex-001"}}'
printf '%s\n' '{"id":"1","msg":{"type":"agent_message","message":"Hello from the mock Codex agent — this reply streamed through /v1/events/stream and was folded into the thread projection."}}'
printf '%s\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"done"}}'
