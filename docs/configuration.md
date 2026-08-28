# Configuration

Micracode is configured through environment variables and, in the
packaged desktop app, the in-app **Settings** panel.

- **Desktop app:** API keys entered in Settings are persisted to a shared
  auth file at `~/.micracode/auth.json` and applied to the running core.
- **From source:** the core backend (`@micracode/core`) reads a `.env` at
  the repo root; the Next.js app picks up `NEXT_PUBLIC_*` vars at
  build/dev time.

A working template is committed at [`.env.example`](../.env.example) —
copy it to `.env` and edit.

## Variable reference

### Web (`apps/web`)

| Variable                   | Default                 | Purpose                                                            |
| -------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | Where the browser calls the core. Must match the port the core binds to. |

### Core backend (`@micracode/core`)

| Variable             | Default            | Purpose                                                                        |
| -------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`     | —                  | Enables OpenAI models. Set at least one provider key.                          |
| `GOOGLE_API_KEY`     | —                  | Enables Google Gemini models.                                                  |
| `ANTHROPIC_API_KEY`  | —                  | Enables Anthropic models (resolved by the pi coding agent SDK).                |
| `PORT`               | `8000`             | Port the core binds in dev (`bun run dev:core`). Ignored in the desktop app, which picks a free port. |
| `OPENER_APPS_DIR`    | `~/opener-apps`    | Override for where generated projects are stored. Absolute path.               |
| `MICRACODE_CONFIG_DIR` | `~/.micracode`   | Directory holding `auth.json` (persisted API keys).                            |

API keys never leave your machine. The browser only learns *whether* a
provider is available (so the model picker can grey out unconfigured
ones); it never sees the keys themselves. The pi coding agent SDK also
resolves keys from your environment and from `~/.pi/agent/auth.json`.

## Choosing a provider and model

The chat composer's **model picker** sends the selected `(provider,
model)` pair with each turn; the selection is remembered in your
browser's localStorage, per-browser (not per-project).

`GET /v1/models` reports the available providers and a minimal built-in
catalog (currently OpenAI and Gemini). Because agent sessions accept a
free-form `model` string, the catalog is mostly a convenience for the
picker rather than a hard allowlist.

To see the live list — including which providers are currently
"available" (a key is configured) — hit:

```bash
curl http://127.0.0.1:8000/v1/models
```

And to check overall health:

```bash
curl http://127.0.0.1:8000/v1/health
```

## Changing ports

The defaults assume:

- Web on `:3000`
- Core on `127.0.0.1:8000`

To use different ports, change them in **two** places so they match:

1. The startup commands — the web port is `bun --filter web dev -- -p
   <port>`; the core port is the `PORT` env var read by `dev:core`.
2. The env var `NEXT_PUBLIC_API_BASE_URL` — point it at the new core URL.

CORS on the core defaults to allowing any origin in dev, so a mismatch
shows up as failed requests to `/v1/...` rather than a browser CORS
error — check that `NEXT_PUBLIC_API_BASE_URL` matches the core's port.

## Changing the storage location

By default, projects are written under `~/opener-apps/`. To put them
elsewhere — for testing, on an external drive, or in a sandbox — set:

```ini
OPENER_APPS_DIR=/absolute/path/to/your/folder
```

The path must be absolute. The core creates the directory if it doesn't
exist. See [Projects on Disk](./projects-on-disk.md) for what gets
written.
