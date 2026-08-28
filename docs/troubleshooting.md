# Troubleshooting

If something doesn't work, start here. Most issues fall into a handful
of categories.

## "Port 3000 / 8000 is already in use"

Another process is bound to the port Micracode wants. Either stop
that process or change ports — see "Changing ports" in
[Configuration](./configuration.md).

Quick check on macOS / Linux:

```bash
lsof -i :3000
lsof -i :8000
```

## The web app loads but nothing happens when I submit a prompt

(Applies when running from source with `bun run dev` — in the packaged
desktop app the core is always running in-process.)

Almost always one of:

1. **The core isn't running.** Check the terminal you started `bun run
   dev` in for core logs. Re-run `bun run dev:core` on its own to see
   startup errors.
2. **`NEXT_PUBLIC_API_BASE_URL` doesn't match the core's port.** The
   defaults are `http://localhost:8000` and `127.0.0.1:8000`, which the
   browser treats as the same origin.
3. **No API key is configured.** See the next section.

Open the browser devtools network tab, find the failing request to
`/v1/...`, and look at the response — it usually says exactly what's
wrong.

## A provider is selected but its key isn't configured

You picked a model for a provider whose key isn't set. Two options:

- **Desktop app:** open **Settings** and paste the key.
- **From source:** add the key to your repo-root `.env`
  (`OPENAI_API_KEY=...`, `GOOGLE_API_KEY=...`, or `ANTHROPIC_API_KEY=...`)
  and restart the core.

Verify what the core thinks is available:

```bash
curl http://127.0.0.1:8000/v1/models
```

The `available: true/false` field per provider is the source of truth.

## Node version errors

If `bun install` or `bun run dev` complains about Node, you're on the
wrong version. From the repo root:

```bash
nvm use   # picks up .nvmrc -> 22.18.0
```

If `nvm` says it isn't installed, run `nvm install 22.18.0` first.

## "I changed `.env` but nothing changed"

The core only reads env vars at startup. Restart it (stop `bun run dev`
with Ctrl-C and start it again, or restart just `bun run dev:core`).

For the web app, `NEXT_PUBLIC_*` vars are baked in at build/dev start —
also a restart.

Keys entered through the desktop app's **Settings** panel take effect
immediately (they're written to `~/.micracode/auth.json` and applied to
the running core).

## My project's files / chat are gone

Check the project folder still exists under `~/opener-apps/` (or
wherever you pointed `OPENER_APPS_DIR`). The workspace reads
everything from disk, so:

- Folder deleted/moved → project is gone from the UI too.
- `.micracode/project.json` deleted or corrupted → the project won't
  load. Restore from a backup if you have one.
- `.micracode/prompts.jsonl` deleted → source files are still fine, but
  chat history is lost. Future turns will work; they just start fresh.

## Browser preview shows COEP / cross-origin warnings

The web app sends strict cross-origin headers
(`Cross-Origin-Embedder-Policy: require-corp`,
`Cross-Origin-Opener-Policy: same-origin`) that the in-browser
sandbox needs.

If you're loading external images, fonts, or scripts in your generated
app and they fail, the upstream needs to send
`Cross-Origin-Resource-Policy: cross-origin` and you need
`crossOrigin="anonymous"` on the tag. For most third-party assets the
fix is to host them locally inside the project instead.

## Still stuck?

Check the per-package READMEs ([apps/core](../apps/core/README.md)) and
the project's issue tracker on GitHub.
