# Projects on Disk

Micracode doesn't use a database. Every project you create is just
a folder on your machine, and the core backend is the only process
that writes to it.

## Where they live

By default, projects live under:

```
~/opener-apps/
```

You can change this by setting `OPENER_APPS_DIR` to an absolute path
before starting the app. See [Configuration](./configuration.md).

## What's inside a project

Each project is a complete, self-contained directory:

```
~/opener-apps/
  my-app/
    app/
      page.tsx           # real source files (git-friendly)
    package.json
    ...                  # whatever else the model has generated
    .micracode/
      project.json       # metadata: id, name, template, timestamps
      prompts.jsonl      # append-only chat history (one JSON per line)
      tempmd-preview.json # secret preview capability (only after sharing)
```

The top of the folder is **just a normal project**. Source files,
`package.json`, configs — they're written exactly as a developer would
write them. You can `cd` into the directory, run `npm install` (or
`bun install`), and treat it like any other repo.

The `.micracode/` subfolder is the only Micracode–specific
thing. It holds:

- **`project.json`** — small metadata file the workspace needs to load
  the project (its UUID, display name, starter template, created/updated
  timestamps).
- **`prompts.jsonl`** — every chat turn for this project, appended
  one JSON object per line. This is what the chat panel replays when
  you reopen the project.
- **`tempmd-preview.json`** — created only after you explicitly share a
  temporary preview. It stores the secret capability needed to update or
  revoke that URL and is written with owner-only permissions where supported.

## Working with projects outside Micracode

Because the project folder is a normal repo, you can:

- **Initialize git** inside it: `git init && git add . && git commit
  -m "first cut"`. You may commit the other `.micracode/` files if you
  want to preserve metadata and chat history, but never commit or share
  `.micracode/tempmd-preview.json`. New starters ignore it automatically.
- **Open it in any editor** — VS Code, Cursor, JetBrains, vim. Changes
  you make on disk are picked up the next time the model reads the
  files.
- **Run it directly.** Once dependencies are installed, the standard
  scripts in `package.json` work as-is.

## Renaming, copying, and deleting

- **Rename:** rename the folder on disk. Note that the URL path inside
  the workspace uses the project's UUID (from `project.json`), not the
  folder name, so the link still works.
- **Copy:** duplicate the folder. Edit `.micracode/project.json` to
  give the copy a new UUID and name; otherwise both projects will fight
  over the same identity in the UI.
- **Delete:** delete the folder. The home page's recent-projects list
  reads from disk, so the entry will disappear on next reload.

## Backups

Backing up is the same as backing up any folder — copy `~/opener-apps/`
(or wherever you pointed `OPENER_APPS_DIR`) somewhere safe. There is no
hidden state outside this directory.

If a backup includes `.micracode/tempmd-preview.json`, protect it like a
password: anyone who obtains that file can update or revoke the preview.

## Security note

The core binds only to `127.0.0.1` and path-checks every write to make
sure it can't escape the project root. That's the boundary you're
trusting: nothing on your LAN can reach the service, and even a buggy
or adversarial model response can't write outside the project's folder
on disk.
