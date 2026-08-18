# `@micracode/core`

TypeScript core backend for the Micracode desktop app, powered by the
[pi coding agent SDK](https://pi.dev/docs/latest/sdk)
(`@earendil-works/pi-coding-agent`).

It runs **in-process inside the Electron main** (see `apps/desktop/src/main.ts`),
exposing the `/v1` HTTP + SSE contract the web renderer already speaks. It
replaces the Python FastAPI backend for the desktop build.

## Run standalone

```bash
PORT=8000 bun run apps/core/src/dev.ts
# or
bun --filter @micracode/core dev
```

Set provider keys in the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
…) — pi resolves them, plus `~/.pi/agent/auth.json` and runtime overrides.
Projects live under `OPENER_APPS_DIR` (default `~/opener-apps`), same layout
as the Python backend (`docs/projects-on-disk.md`).

## Architecture

Event-sourced, matching the ts-rs contract in
`apps/web/src/lib/api/generated/`:

- **`eventlog.ts`** — append-only log; every state change is a `StoredEvent`
  with a global `seq`. Backs `GET /v1/events` and `GET /v1/events/stream`.
- **`sessions.ts`** — one pi agent run per session, bound to a project
  workspace. pi's streamed events are translated into log entries.
- **`storage.ts`** — projects on disk (`.micracode/project.json` + `prompts.jsonl`).
- **`server.ts`** — the Hono `/v1` app.
- **`index.ts`** — `startCoreServer()`, the in-process entry the Electron main imports.

## Implemented (vertical slice)

`GET /v1/health` · `GET /v1/models` · projects CRUD + `/files` + `/prompts` ·
sessions `start` / `turn` / `interrupt` / `resume` / `stop` · `GET /v1/events(+/stream)`

## Not yet ported (return `501`)

Thread projections (`/v1/threads/:id`), VCS + checkpoints
(`/v1/projects/:id/vcs`, `/checkpoints`), the command bus (`/v1/commands`),
snapshots, project zip download, starter-template scaffolding, and tool
permission/approval round-trips. See the comments in the source
for each shortcut and its upgrade path.
