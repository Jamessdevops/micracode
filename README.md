<div align="center">

<h1 style="border-bottom: none">
    <b>Micracode</b><br />
    Open-Source AI Web App Builder
</h1>

<img alt="Micracode Demo" src="./demo.gif" style="width: 100%">

<br/>
<p align="center">
  Describe an app in natural language and Micracode streams code into an in-browser workspace.<br />
  Iterate by chat or edit the code directly in a Monaco editor — everything runs on your laptop.
</p>

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org/)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg)](https://www.typescriptlang.org/)

</div>

<br />
<div align="center">
<em>Your local AI coding workspace — no database, no auth, no cloud.</em>
</div>
<br />

---

## Quick Install

Micracode ships as a desktop app. Download the latest macOS build from the
[**Releases**](https://github.com/Jamessdevops/micracode/releases) page, open it,
and you're ready to go — no Node.js, no Python, no separate backend to run. The
core backend runs in-process inside the app.

### 1. Add an API key

On first launch, open **Settings** and paste a key for whichever LLM provider
you want to use — OpenAI, Google (Gemini), or Anthropic. The model picker shows
whichever providers have a key set. Keys are stored locally in a config file on
your machine; nothing is sent to a Micracode server.

### 2. Build something

- Type a description on the home screen → Micracode generates a working project
- Chat to iterate, edit code in the Monaco editor, and preview your app live
- Projects are saved as plain folders at `~/opener-apps/`

---

## Getting started & staying tuned with us.

Star us, and you will receive all release notifications from GitHub without any delay!

---

## Features

| ![Image 1](https://github.com/user-attachments/assets/26e56738-fa6f-44e3-aefa-c8db4f97540a) | ![Image 2](https://github.com/user-attachments/assets/aa8ad40d-7bf9-45cb-a815-00d8efe8ffdf) |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |

---

##  Tech Stack

### Core backend (`@micracode/core`)
- **TypeScript** — runs **in-process inside the Electron main** (no spawned child)
- **[pi coding agent SDK](https://pi.dev/docs/latest/sdk)** — LLM orchestration and tool use
- **Hono** — the `/v1` HTTP + SSE app the renderer talks to
- **Event-sourced** — an append-only log backs `/v1/events` and the live stream

### Desktop shell
- **Electron 33** — packages the web UI + core into a native app
- **electron-builder** + **electron-updater** — builds and auto-updates releases

### Frontend (`apps/web`)
- **Next.js 15** — React framework with App Router
- **React 19** — Latest React with concurrent features
- **Tailwind CSS** — Utility-first CSS framework
- **Radix UI** + **shadcn/ui** — Accessible component primitives
- **Monaco Editor** — VS Code's editor in the browser
- **Zustand** — Lightweight state management
- **ai-sdk** — Vercel AI SDK for chat streaming

### Tooling
- **Bun** — JS workspace manager and runtime
- **TypeScript** — End-to-end type safety, with shared types in `packages/shared`

---

## Development Setup

> For contributors and people building from source. If you just want to use Micracode, download it from [Releases](https://github.com/Jamessdevops/micracode/releases).

### Prerequisites
- **Node.js** v22.18.0 (pinned via `.nvmrc`)
- **Bun** ≥ 1.1.0
- An **OpenAI**, **Google Gemini**, or **Anthropic** API key

### Environment Setup

Copy the example env file and add your key(s):
```bash
cp .env.example .env
$EDITOR .env
```

Minimum config (any one provider key works):
```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
OPENAI_API_KEY=your_openai_api_key
# or GOOGLE_API_KEY / ANTHROPIC_API_KEY
```

Projects are written to `~/opener-apps` by default; override with `OPENER_APPS_DIR`.

### Installation

```bash
nvm use                # picks up .nvmrc -> Node 22.18.0
bun install            # installs all workspaces (web, core, desktop, shared)
```

### Running the Application

Run the **desktop app** in dev (web UI + core inside Electron):
```bash
bun run desktop
```

Or run the **web + core** stack in the browser (no Electron):
```bash
bun run dev            # Next.js on :3000, @micracode/core on :8000
```

You can also run them individually:
```bash
bun run dev:web        # Next.js only
bun run dev:core       # @micracode/core only (PORT=8000)
```

Open <http://localhost:3000> (or the desktop window), type a project description
into the prompt box, and you're off.

### Building a Release

```bash
bun run build          # build the Next.js frontend
bun run desktop:release # package a signed macOS app via electron-builder
```

---

## Project Structure

```
micracode/
├── apps/
│   ├── web/                    # Next.js 15 frontend (renderer)
│   │   ├── src/
│   │   │   ├── app/            # App Router pages
│   │   │   ├── components/     # React components (incl. shadcn/ui)
│   │   │   ├── lib/            # Utilities, API clients, generated types
│   │   │   └── store/          # Zustand stores
│   │   └── package.json
│   │
│   ├── core/                   # @micracode/core — TS backend (in-process)
│   │   └── src/
│   │       ├── server.ts       # Hono /v1 app
│   │       ├── sessions.ts     # one pi agent run per session
│   │       ├── eventlog.ts     # append-only event log
│   │       ├── storage.ts      # local filesystem project storage
│   │       └── index.ts        # startCoreServer() entry point
│   │
│   └── desktop/                # Electron shell
│       ├── src/main.ts         # imports the core, serves the renderer
│       └── electron-builder.config.js
│
├── packages/
│   └── shared/                 # Shared TypeScript types (stream event contract)
│
├── docs/                       # End-user documentation
└── README.md
```

---

## API Endpoints

The core exposes a `/v1` HTTP + SSE contract that the renderer speaks.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/v1/health` | Service health check |
| GET    | `/v1/models` | List available LLM models (per configured keys) |
| GET/POST | `/v1/settings` | Read / update provider keys |
| POST   | `/v1/generate` | Stream code generation events (SSE) |
| GET/POST | `/v1/projects` | List / create projects |
| GET/DELETE | `/v1/projects/{id}` | Get / delete a project |
| GET/PUT | `/v1/projects/{id}/files` | Read / write project files |
| GET    | `/v1/projects/{id}/prompts` | Prompt history |
| POST   | `/v1/sessions` | Start an agent session |
| POST   | `/v1/sessions/{id}/turn` | Send a turn to a session |
| POST   | `/v1/sessions/{id}/interrupt` `resume` | Control a running session |
| DELETE | `/v1/sessions/{id}` | Stop a session |
| GET    | `/v1/events` , `/v1/events/stream` | Event log (poll / SSE) |

Some endpoints (VCS/checkpoints, threads, command bus, project download,
snapshots) are stubbed and return `501` — see `apps/core/README.md` for the
full status of the vertical slice.

---

## Documentation

End-user docs live in [`docs/`](./docs/README.md):

- **[Getting Started](./docs/getting-started.md)** — install, configure a key, and run the app.
- **[Configuration](./docs/configuration.md)** — environment variables and supported model IDs.
- **[Using the Workspace](./docs/usage.md)** — the home page, chat, editor, and preview panels.
- **[Projects on Disk](./docs/projects-on-disk.md)** — where your generated apps live.
- **[Troubleshooting](./docs/troubleshooting.md)** — common errors and how to fix them.
- **[FAQ](./docs/faq.md)** — short answers to common questions.

---

## Useful Scripts

```bash
bun run desktop        # Electron app in dev (web + core in-process)
bun run dev            # web + core in the browser (:3000 / :8000)
bun run dev:web        # Next.js only
bun run dev:core       # @micracode/core only
bun run build          # build the Next.js frontend
bun run desktop:release # package a macOS release
bun run typecheck      # TS across all workspaces
bun run lint           # eslint across workspaces
bun run format         # prettier
```

---

## Contributor ♥️

Big thanks to everyone who's been part of the Micracode journey. 

Micracode is a community effort, and it keeps getting better because of people like you.

![Contributors](https://contrib.rocks/image?repo=Jamessdevops/micracode&max=500&columns=20&anon=1)

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Contributing

Contributions are welcome! Feel free to open issues and pull requests.

---

**Join our community** [Discord](https://discord.gg/YmBNWhwdg)
