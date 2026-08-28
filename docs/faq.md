# FAQ

### Does Micracode send my code or prompts to a server I don't control?

Only to the LLM provider you choose (OpenAI, Google Gemini, or
Anthropic), and only the parts of the conversation needed to answer the
current turn. The Micracode core runs locally on `127.0.0.1` (in the
desktop app it runs in-process). There's no telemetry endpoint and no
Micracode–run cloud service.

### Do I need keys for every provider?

No — one is enough. Configure whichever provider you want to use. The
model picker only enables models from providers that have a key
configured.

### Can I run this on a server / VM / share it on a LAN?

Out of the box, no. The core binds to `127.0.0.1` so it only accepts
connections from the same machine. Exposing it to a network would be a
significant change and would need real authentication, a tighter CORS
config, and an ingress in front. It's intended to run on your laptop,
for you.

### Where is my data?

On your filesystem, under `~/opener-apps/` (or wherever you pointed
`OPENER_APPS_DIR`). See [Projects on Disk](./projects-on-disk.md).

### Can I use the generated apps without Micracode running?

Yes. Each project folder is a normal repo. Install its dependencies
with `bun install` (or `npm install`) and run its standard scripts.

### Can I edit files in another editor while Micracode is open?

Yes — the model reads files fresh from disk each turn, so external
edits are picked up the next time you chat. Just don't edit the same
file in two places at once or you'll get a conflict on save.

### How do I switch models mid-project?

Use the model picker in the chat composer at the bottom of the chat
panel. The change applies to the next turn; your project's history and
files are untouched.

### Can I delete a project?

Delete its folder under `~/opener-apps/`. The home page recent-projects
list reads from disk, so the entry will disappear on next reload.

### Can I version-control my projects?

Yes. `cd` into the project folder and `git init`. The
`.micracode/` subfolder contains the chat history (`prompts.jsonl`)
and project metadata (`project.json`) — commit them if you want to
preserve the conversation alongside the code, or `.gitignore` them if
you don't.

### Is there an account or login?

No. Micracode has no auth, no users, no accounts.

### What's the license?

MIT — see the [`LICENSE`](../LICENSE) file.
