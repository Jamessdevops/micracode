# test-frontend

A zero-build, single-file **React** chat client for the Rust `micracode-api`
backend (`desktop/api`), styled after the Claude desktop app. It's still just
`index.html` with no bundler or `npm install`: React 18 and Babel load from a
CDN, and the app's JSX is transpiled in-browser (with the classic runtime, so it
compiles to `React.createElement` and needs no module system). Loading therefore
needs network access for the CDN; serve and run it exactly as before.

It's a real chat surface, not a debug panel, but every interaction maps to a
backend endpoint:

- **New chat / send** — lazily starts a session (`POST /v1/sessions` with the
  **Claude / Codex** harness picked in the top-left or composer), then posts each
  message as a turn (`POST /v1/sessions/{id}/turn`). PRD FR1.
- **Permission mode** — the shield pill in the composer sets how much autonomy the
  agent gets, sent as `permission` on `POST /v1/sessions`:
  - `bypassPermissions` (default) — `claude --dangerously-skip-permissions`
  - `acceptEdits` — auto-accept edits in the workspace
  - `plan` — read & propose only, no file changes
  - `default` — standard prompting (restricted when headless)

  Each mode maps onto the CLI's own permission/sandbox flags (Codex varies its
  `sandbox_mode` tier), and is persisted so a resumed session re-applies it.
- **Streaming replies** — subscribes to `GET /v1/events/stream` (SSE) and, as the
  session's `provider.*` events land, refetches the projected thread
  (`GET /v1/threads/{id}`) and re-renders. Assistant text and tool calls appear
  as the turn progresses. PRD FR2.
- **Recents sidebar** — `GET /v1/threads`, **grouped by the folder each chat was
  opened in** (`thread.workspace`, like t3 code / Codex desktop). Click a
  conversation to reopen it; click a folder header to collapse/expand the group.
- **Folder picker** — the folder button at the top of the sidebar sets which
  folder a **New chat** opens in, sent as `workspace` on `POST /v1/sessions`. It
  lists every folder seen across threads plus **Open folder…**, which pops the
  **native OS folder dialog** (`POST /v1/fs/pick`) and uses the path you choose.
  The backend opens the dialog because a browser can't read a local folder's
  absolute path — only its name — and the session needs a real path; since the
  backend runs on your machine, it shows the real Finder "Choose Folder" sheet
  (macOS). Opening an existing chat follows it into its folder, so the next new
  chat continues there; the active folder's group floats to the top of Recents.

## Run

1. Start the backend. To answer with the **real Claude CLI** (like t3 code
   does), point `CLAUDE_BIN` at the `claude` binary — the backend spawns
   `claude -p --output-format stream-json --input-format stream-json --verbose
   --dangerously-skip-permissions` per session and streams its output back:

   ```bash
   cd desktop/api
   source "$HOME/.cargo/env"
   CLAUDE_BIN="$(command -v claude)" cargo run    # serves http://127.0.0.1:8000
   ```

   If `claude` is already on the launching shell's PATH you can just run
   `cargo run`. Each turn is a real API call and is billed accordingly. To test
   the plumbing without spending tokens, use the mocks below instead.

2. Serve this folder. **Use port 3000** — the backend's CORS allow-list defaults
   to `http://localhost:3000`, so the browser's `fetch`/`EventSource` calls are
   accepted without extra config:

   ```bash
   cd desktop/test-frontend
   python3 -m http.server 3000
   ```

   Open <http://localhost:3000>. (`file://` is CORS-blocked; to allow another
   origin set `APP_WEB_ORIGIN` when starting the backend.)

The API base URL and an optional workspace path live behind the gear icon in the
sidebar footer.

## Testing without the real CLIs

A live reply needs the agent CLI installed and on `PATH` — `claude` or `codex`.
You can point the backend at either binary with `CLAUDE_BIN` / `CODEX_BIN`.

This folder ships two **mock agents** under `mocks/` that speak the exact wire
protocols the adapters expect, so you can drive the full session → SSE →
projection path (and the harness switch) without installing anything:

- [`mocks/mock-codex.sh`](mocks/mock-codex.sh) — Codex `proto` event-queue mock.
- [`mocks/mock-claude.sh`](mocks/mock-claude.sh) — Claude Code `stream-json` mock;
  streams a text reply **and a `Bash` tool call + result** so the tool card
  renders.

Run the backend with both wired in:

```bash
cd desktop/api
CODEX_BIN="$PWD/../test-frontend/mocks/mock-codex.sh" \
CLAUDE_BIN="$PWD/../test-frontend/mocks/mock-claude.sh" \
  cargo run
```

Then pick **Claude** or **Codex** in the composer (or top-left) and send a
message. Each mock replies once and the session closes — start a **New chat** for
another turn. Swap in the real `claude` / `codex` binary (or just unset the env
var) to drive a real agent.

## Notes

- "Send turn" itself only returns `{ "accepted": true }`; the visible answer
  arrives over the event stream and is folded into the thread projection — so the
  UI is genuinely exercising the event-sourced path, not a direct request/reply.
- Without a CLI (real or mock), the first turn shows a spawn hint instead of a
  reply; the engine, event stream and projection still work.
