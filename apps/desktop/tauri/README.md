# Micracode Desktop (Tauri 2.0)

A native desktop shell for Micracode built with [Tauri 2.0](https://tauri.app) and
Rust. It coexists with the Electron shell in `apps/desktop` and loads the **same**
Next.js frontend (`apps/web`), so the two are interchangeable from the user's point
of view.

## Layout

```
apps/desktop/tauri/
├── Cargo.toml            # Rust crate manifest
├── build.rs              # tauri-build hook
├── tauri.conf.json       # Tauri app/bundle config
├── capabilities/         # Tauri 2.0 permission capabilities
│   └── default.json
├── icons/                # Generated app icons (cargo tauri icon)
└── src/
    ├── main.rs           # Binary entry point
    └── lib.rs            # App setup + IPC commands
```

## How the frontend is wired

`tauri.conf.json` mirrors the Electron shell:

- **Dev** — `devUrl` points at `http://localhost:3000`; `beforeDevCommand` runs
  `bun run dev` in `apps/web` (Next.js dev server).
- **Build** — `frontendDist` points at `apps/web/out`; `beforeBuildCommand` runs
  `bun run build`, which produces the static export (`output: "export"`).

## IPC bridge

The Electron `electronAPI` bridge is reproduced as Tauri commands in
[`src/lib.rs`](src/lib.rs), backed by a JSON settings store
(`settings.json` in the app config dir):

| Electron IPC        | Tauri command       | Notes                                  |
| ------------------- | ------------------- | -------------------------------------- |
| `get-backend-port`  | `get_backend_port`  | Defaults to `49152`.                   |
| `get-api-keys`      | `get_api_keys`      | Returns the stored key map.            |
| `save-api-keys`     | `save_api_keys`     | Persists the key map.                  |

Call them from the frontend with:

```ts
import { invoke } from "@tauri-apps/api/core";
const port = await invoke<number>("get_backend_port");
```

> The Electron `start-dev-server` / `stop-dev-server` commands (per-project
> process spawning) are intentionally **not** ported yet — they need process
> lifecycle management. Add them as Tauri commands when needed.

## Prerequisites

- Rust (stable) — `curl https://sh.rustup.rs -sSf | sh`
- Tauri CLI — `cargo install tauri-cli --version "^2.0"`
- Node/Bun (for the `apps/web` frontend) — see repo `.nvmrc` (22.18.0)

## Develop

```bash
# from this directory
cargo tauri dev
```

This starts the Next.js dev server (via `beforeDevCommand`) and opens the
native window.

## Build

```bash
cargo tauri build
```

## Regenerate icons

```bash
cargo tauri icon path/to/source-1024.png
```
