# micracode-api (Rust)

A Rust ([Axum](https://github.com/tokio-rs/axum)) reimplementation of the Micracode
`/v1` backend. It's a drop-in replacement for the Python FastAPI service
(`apps/api`) for the endpoints implemented so far, talking to the **same**
on-disk data directory (`~/opener-apps` by default) and emitting JSON that is
byte-compatible with the TS API clients in `apps/web/src/lib/api/`.

This is the harness layer for the desktop app: rather than shelling out to a
Python process, the Tauri shell can run/spawn this single static binary, and the
generation step will lean on the LLM provider's own SDK/harness (like t3 code)
instead of a hand-rolled tool loop.

## Endpoints (this pass: projects + models)

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET    | `/v1/health` | status / provider / model |
| GET    | `/v1/models` | provider catalog + Ollama probe |
| GET    | `/v1/projects` | list, newest first |
| POST   | `/v1/projects` | create (201) |
| GET    | `/v1/projects/{id}` | includes `root_path` |
| DELETE | `/v1/projects/{id}` | 204 |
| GET    | `/v1/projects/{id}/files` | `{ "tree": FileSystemTree }` |
| PUT    | `/v1/projects/{id}/files` | write a file (204) |
| GET    | `/v1/projects/{id}/download` | zip stream |
| GET    | `/v1/projects/{id}/prompts` | chat history |
| POST   | `/v1/projects/{id}/prompts/pop-assistant` | `{ "popped": bool }` |
| GET    | `/v1/projects/{id}/snapshots` | list |
| POST   | `/v1/projects/{id}/snapshots/{sid}/restore` | 204 |
| DELETE | `/v1/projects/{id}/snapshots/{sid}` | 204 |

**Not yet ported:** `POST /v1/generate` (streaming) and its question-answer
resume endpoint.

### Event-sourced core (PRD §9)

The same binary also exposes the Rust event-sourced engine and the Claude
provider slice over HTTP/SSE:

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST   | `/v1/commands` | dispatch a command through the engine (idempotent by `id`) |
| GET    | `/v1/events?cursor=N` | replay the append-only log from a cursor |
| GET    | `/v1/events/stream?cursor=N` | SSE: replay then live-push appended events |
| POST   | `/v1/sessions` | start a Claude session bound to a project/workspace |
| POST   | `/v1/sessions/{id}/turn` | send a user turn |
| POST   | `/v1/sessions/{id}/interrupt` | interrupt the running turn |
| DELETE | `/v1/sessions/{id}` | stop and reap the session |
| GET    | `/v1/threads` | **read model**: thread summaries folded from the log (each carries its `workspace` folder) |
| GET    | `/v1/threads/{id}` | **read model**: full thread (turns + messages) |
| POST   | `/v1/fs/pick` | pop the **native** OS folder dialog (macOS `choose folder`) and return the chosen absolute path, for the UI's folder picker |

The `/v1/threads` endpoints serve a [`Projection`](../../apps/desktop/tauri/crates/core-projection)
folded from the event log (threads → turns → messages, PRD FR2). It is rebuilt
from the log on startup and kept live off the store's hot stream, so restarting
the process reconstructs the same state by replay. `CLAUDE_BIN` overrides the
`claude` binary used for sessions.

## Configuration

Reads the same env vars as the Python service (`.env` at the repo root and
`apps/api/.env` are loaded automatically; process env wins):

- `LLM_PROVIDER`, `GOOGLE_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`,
  `OPENAI_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- `OPENER_APPS_DIR` — storage root (default `~/opener-apps`)
- `APP_WEB_ORIGIN` — comma-separated CORS allow-list (default
  `http://localhost:3000`)
- `LOG_LEVEL`, `ENVIRONMENT`
- `MICRACODE_API_HOST` / `MICRACODE_API_PORT` (or `PORT`) — bind address
  (default `127.0.0.1:8000`, matching `NEXT_PUBLIC_API_BASE_URL`)

## Run

```bash
source "$HOME/.cargo/env"   # toolchains aren't on the default PATH here
cargo run                   # serves on http://127.0.0.1:8000
```
