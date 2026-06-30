#!/usr/bin/env bash
# Minimal Claude Code `stream-json` mock. Headless Claude is driven as:
#   claude -p --output-format stream-json --input-format stream-json --verbose
# It reads one user submission per line:
#   {"type":"user","message":{"role":"user","content":"<text>"}}
# and emits one JSON object per line. This mock reads the first turn, then
# streams: system/init -> assistant(text + tool_use) -> user(tool_result)
# -> assistant(final text) -> result/success, then exits (flushing stdout).
read -r _submission
printf '%s\n' '{"type":"system","subtype":"init","session_id":"mock-claude-001","tools":["Bash"]}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure — let me check the directory."},{"type":"tool_use","id":"toolu_mock_1","name":"Bash","input":{"command":"ls -1"}}]}}'
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_mock_1","content":"README.md\nsrc\nCargo.toml","is_error":false}]}}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"This is the mock Claude agent. It streamed a tool call (Bash: ls -1) and this reply through the same stream-json adapter and event-sourced projection the real Claude CLI uses."}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"Done — listed 3 entries.","is_error":false,"session_id":"mock-claude-001"}'
