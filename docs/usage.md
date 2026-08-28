# Using the Workspace

Once you have Micracode running (see
[Getting Started](./getting-started.md)), the app has two screens: the
**home page** for starting projects, and the **workspace** for working
on one.

## The home page

Open <http://localhost:3000>.

The home page is dominated by a single prompt box. Type a description
of the app you want to build — a sentence or two is enough — and submit.

What happens:

1. A new project is created on disk under `~/opener-apps/<slug>/`.
2. You're navigated to that project's workspace
   (`/projects/<id>`).
3. Your initial prompt is sent to the model and code starts streaming
   in.

Recent projects are listed lower on the page so you can jump back into
anything you've worked on before.

## The workspace

The workspace is a three-panel layout:

```
┌──────────────┬─────────────────────────────┬──────────────┐
│              │                             │              │
│   Chat       │   File tree + Code editor   │   Preview    │
│   (left)     │   (center)                  │   (right)    │
│              │                             │              │
└──────────────┴─────────────────────────────┴──────────────┘
```

You can resize the panels by dragging the dividers between them.

### Chat panel (left)

This is your conversation with the model. Each message you send becomes
a new turn; the response streams in token-by-token, with file writes
showing up live in the editor's file tree as they happen.

At the bottom of the chat input you'll see the **model picker**.
Use it to switch between providers (OpenAI / Google Gemini / Anthropic)
and models. Greyed-out entries mean no key is configured for that
provider — see [Configuration](./configuration.md) to add one.

The chat history for each project is persisted to disk (in
`prompts.jsonl` inside the project folder) so it's still there when you
come back later.

### Editor panel (center)

The center panel has two parts:

- **File tree** on the left lists every file in the project.
  Click a file to open it.
- **Monaco editor** on the right shows the file. You can edit it
  directly — saving sends the change to the core, which writes it to
  disk in the project folder. The model sees these edits on its next
  turn.

Above the editor you'll see the path of the current file. With no file
open, the panel shows a short keyboard-shortcut hint.

### Preview panel (right)

The preview panel is where the running app appears. In the current
phase of the project the preview surface is in place but the
in-browser Node.js sandbox that actually runs the generated app is
delivered in a later phase, so what you see today depends on which
build you're on. The console area below the preview shows logs from
the sandbox once it's running.

## A typical session

1. Start from the home page with a clear, specific prompt:
   *"A todo list with categories and a dark mode toggle, using Next.js
   App Router and Tailwind."*
2. Watch files appear in the tree as the model streams them.
3. Use the chat panel to iterate: *"Add a search box that filters by
   title."* The model will edit the relevant files in place.
4. Open files in the editor to read or tweak them by hand. Hand-edits
   are visible to the model on the next turn.
5. Switch models from the picker if you want a second opinion or
   cheaper iterations on small changes.
6. Close the tab whenever — your project is on disk, and you can
   resume from the home page's recent-projects list.

## Tips

- **Be specific in prompts.** Naming the framework, the styling
  library, and any constraints up front saves rework.
- **Edit the code, don't just chat.** Small fixes are faster to type in
  the editor than to describe.
- **Check the console.** When something doesn't render, the preview's
  console panel usually has the answer.
- **One project per directory.** Each folder under `~/opener-apps/` is
  a complete, standalone repo — you can `cd` into it and run it
  outside Micracode if you want.
