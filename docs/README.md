# Micracode — User Documentation

Micracode is an open-source, AI-powered web app builder that runs
entirely on your laptop. You describe an app in natural language, and it
streams code into a workspace where you can chat to iterate, edit files
directly, and preview the result live.

This folder contains everything you need to install, configure, and use
the app. Start with [Getting Started](./getting-started.md).

## Table of contents

1. [Getting Started](./getting-started.md) — download or build the app and run it for the first time.
2. [Configuration](./configuration.md) — environment variables, API keys, and providers.
3. [Using the Workspace](./usage.md) — the home page, three-panel workspace, chat, editor, and preview.
4. [Projects on Disk](./projects-on-disk.md) — where your generated apps live and what's inside them.
5. [Troubleshooting](./troubleshooting.md) — common errors and how to fix them.
6. [FAQ](./faq.md) — short answers to common questions.

## At a glance

- **Local-first.** No database, auth, or cloud service is required.
  Everything lives under `~/opener-apps/` unless you explicitly create
  a public temporary preview.
- **Bring your own key.** Works with OpenAI, Google Gemini, or Anthropic.
  Keys stay on your machine.
- **Desktop app.** Micracode ships as an Electron app. The core backend
  (`@micracode/core`, TypeScript) runs **in-process** inside it — there's
  no separate server to start. For development you can also run the web
  UI and core in the browser with `bun run dev`.

If you're a contributor looking for architecture or code-level docs, see
the per-package READMEs under [`apps/web`](../apps/web),
[`apps/core`](../apps/core), [`apps/desktop`](../apps/desktop), and
[`packages/shared`](../packages/shared).
