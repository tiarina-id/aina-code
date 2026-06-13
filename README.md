# ainacode (`aina`)

An AI coding assistant for your terminal. `aina` can read and edit files, run
commands, search your codebase, and complete multi-step tasks agentically —
right from your shell, with colored diffs, change confirmations, file
autocomplete, and a built-in bash mode.

It connects to the `api.tiarina.id` gateway using first-party models
(`aina-1-flash` / `aina-1-mini` / `aina-1-pro` / `aina-1-ultra`).

## Features

- 🤖 **Agentic tool-use** — reads, writes, and edits files, runs commands,
  searches code (regex grep + glob find), and inspects git.
- 🩹 **Robust edits** — exact match with a whitespace-tolerant fallback; apply
  many edits at once, atomically.
- 🔁 **Self-checking** — after changing files, `aina` can auto-run your
  typecheck/lint and fix the errors it introduced.
- 📋 **Default / Plan / Auto modes** — Plan is read-only (drafts a plan only),
  Auto skips confirmations. Press `Tab` to cycle.
- ✅ **Safe by default** — file changes and commands show a diff/preview and ask
  for approval. Actions outside the working folder always require confirmation,
  and risky commands (e.g. `rm -rf`, `sudo`) always need explicit confirmation.
- 🧠 **Project context** — automatically reads `AINA.md` / `CLAUDE.md` /
  `AGENT.md` from your working folder; `/init` generates an `AINA.md` for you.
- ↩️ **Undo** — revert the last file change with `/undo`.
- 📎 **File attach `@`** — type `@path` to drop a file's contents into your message.
- 🐚 **Bash mode `!`** — run a shell command directly without the model.
- 📨 **Message queue** — keep typing while a task runs; queued messages run next.

## Requirements

- **Node.js ≥ 18**

## Installation

```bash
npm install -g ainacode
```

## Configuration

The first time you run `aina` without an API key, it will prompt for one and save
it to `~/.ainacode/config.json`.

You can also configure it via environment variables (these take precedence over
the config file):

| Variable | Description | Default |
|----------|-------------|---------|
| `AINA_API_KEY`  | Your Tiarina API key (required) | — |
| `AINA_MODEL`    | Default model | `aina-1-flash` |
| `AINA_BASE_URL` | Gateway base URL | `https://api.tiarina.id/v1` |
| `AINA_AUTO_VALIDATE` | Auto typecheck/lint after edits (`false`/`0` disables) | `true` |
| `AINA_VALIDATE_CMD`  | Override the validation command (e.g. `npm run typecheck`) | auto-detected |

You can view or change settings at any time from inside the app with `/config`.

## Usage

```bash
aina                                   # interactive shell (REPL)
aina "explain src/index.ts"            # one-shot query
aina -m aina-1-pro "optimize this function"   # override the model
aina -y "tidy up all imports"          # start in auto-approve mode
aina --version                         # print the version
aina --help                            # print help
```

### CLI options

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Use a model for this invocation |
| `-y, --yes` | Auto-approve mode (skip tool confirmations) |
| `-v, --version` | Print the version |
| `-h, --help` | Print help |

### Inside the REPL

| Command | Action |
|---------|--------|
| `/help` | Show help |
| `/model [name]` | Show or switch the active model |
| `/init` | Generate/update `AINA.md` (project context) |
| `/undo` | Undo the last file change (write/edit/delete/move) |
| `/check` | Run validation (typecheck/lint) now |
| `/diff` | Show the git diff of your changes |
| `/commit "message"` | Stage all & commit (with confirmation) |
| `/resume` | Resume your previous session |
| `/compact` | Summarize & shrink the conversation context |
| `/usage` | Show input/output token usage, cost estimate & context size |
| `/status` | Show model, mode, directory, session & usage |
| `/config [key value]` | Show or change configuration |
| `/plan` | Toggle Plan mode (read-only, plan only) |
| `/auto` | Toggle auto-approve mode |
| `/clear` | Reset history & clear the screen |
| `/exit` | Quit |
| `Tab` | Switch mode (Default → Plan → Auto) |
| `@<file>` | Attach a file's contents to your message |
| `!<command>` | Run a bash command directly |

Press `Esc` to cancel a running task.

## Models

| ID | Name |
|----|------|
| `aina-1-flash` | Aina 1 Flash (default, fast & balanced) |
| `aina-1-mini`  | Aina 1 Mini (lightweight & very fast) |
| `aina-1-pro`   | Aina 1 Pro (advanced reasoning & coding) |
| `aina-1-ultra` | Aina 1 Ultra (maximum intelligence) |

## Modes & safety

- **Default** — asks for confirmation before changing files or running commands.
- **Plan** — read-only; investigates and drafts a plan, changes nothing.
- **Auto** — skips confirmations for a faster session.

In every mode, actions targeting files **outside the working folder** always ask
for confirmation, and risky commands (`rm -rf`, `sudo`, `mkfs`, `git push
--force`, piping to a shell, …) always require explicit confirmation. Code
search and the file picker respect your `.gitignore`.

## Privacy

- Your API key is read from `AINA_API_KEY` or `~/.ainacode/config.json` (stored
  locally). Without a key, `aina` stops with a clear message.
- Files you read or `@`-attach, and commands you run, are sent to the
  `api.tiarina.id` gateway as part of the context. Respecting `.gitignore` helps
  avoid sending secrets (e.g. `.env`) by accident.
- Your resumable session history is stored locally under
  `~/.ainacode/sessions/<uuid>.json`, with the latest pointer at
  `~/.ainacode/last-session.json`.
- `/usage` shows prompt/completion/total tokens plus a best-effort cost estimate
  for known Aina models; unknown model prices are shown as unavailable.
- `diag.mjs` requires a real API key from `AINA_API_KEY` or config and exits
  clearly when none is configured.

## Platform Notes

- Linux and macOS terminals are the primary supported environments.
- Windows dangerous-command detection is included. For best results, use Windows
  Terminal with PowerShell and Node.js 18+.
- Full raw TTY/ANSI behavior is best-effort on Windows and has not been fully
  verified in this audit, so avoid claiming full Windows support until tested on
  native Windows terminals.

## Quality Gate

- CI runs `npm run build`, `npm test`, and `npm run lint` on push and pull
  requests.

## License

ISC — see [LICENSE](./LICENSE).
