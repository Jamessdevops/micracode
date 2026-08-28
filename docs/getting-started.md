# Getting Started

This guide gets you from nothing to a running Micracode with your first
project open in the workspace.

## Option A — Just use the app

Download the latest macOS build from the
[**Releases**](https://github.com/Jamessdevops/micracode/releases) page and
open it. There's no Node.js, no Python, and no backend to run separately —
the core runs in-process inside the app.

On first launch, open **Settings**, paste an API key for your provider
(OpenAI, Google Gemini, or Anthropic), and skip to
[Create your first project](#create-your-first-project) below.

## Option B — Build from source

For contributors, or to run the web UI in a browser.

### 1. Install prerequisites

| Tool | Version    | Install                                                              |
| ---- | ---------- | ------------------------------------------------------------------- |
| Node | `v22.18.0` | [`nvm`](https://github.com/nvm-sh/nvm): `nvm install 22.18.0 && nvm use` |
| Bun  | `>= 1.1.0` | [`bun`](https://bun.sh): `curl -fsSL https://bun.sh/install \| bash`  |

The repo's `.nvmrc` pins the Node version, so `nvm use` from the project
root picks the right one.

### 2. Get the code

```bash
git clone <your fork or the upstream repo> micracode
cd micracode
nvm use
```

### 3. Install dependencies

```bash
bun install   # installs all workspaces (web, core, desktop, shared)
```

### 4. Add an API key

Copy the committed template to a `.env` at the repo root and fill in
**one** provider's key:

```bash
cp .env.example .env
$EDITOR .env
```

Minimum to get going:

```ini
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
OPENAI_API_KEY=your-openai-key
# or GOOGLE_API_KEY=... / ANTHROPIC_API_KEY=...
```

See [Configuration](./configuration.md) for the full reference.

### 5. Run it

Run the desktop app (web UI + core in-process, inside Electron):

```bash
bun run desktop
```

…or run the web + core stack in your browser:

```bash
bun run dev
```

This starts two processes in parallel:

- Web: <http://localhost:3000>
- Core backend: <http://127.0.0.1:8000>

Leave it running; you'll see logs from both in the same terminal.

## Create your first project

1. Open the app window (or <http://localhost:3000> in browser mode).
2. On the home page, type a one-line description of what you want to
   build into the prompt box and submit.
3. You'll be taken to the workspace, where the chat panel, file tree,
   editor, and preview are visible. Generated files appear in the tree
   as the model streams them in.
4. Use the chat panel to iterate — ask for changes, fixes, or new
   features. Edits you make in the Monaco editor are saved to disk.

That's it. Your project's source files now live under `~/opener-apps/`
— see [Projects on Disk](./projects-on-disk.md) for the layout.

## What's next

- [Using the Workspace](./usage.md) — tour the UI and the three panels.
- [Configuration](./configuration.md) — change providers, ports, or
  storage location.
- [Troubleshooting](./troubleshooting.md) — if something didn't start.
