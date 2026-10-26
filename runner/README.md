# Multicode AI runner

The desktop app includes the runner and connects after sign-in. No Node.js,
npm command or application source checkout is needed for the desktop runner.
Git and the AI provider's CLI must be installed and signed in on your computer.

For browser users, install Node.js 22 or newer (which includes npm/npx).
In **Your computers → Connect a computer**, copy the pairing command for your
workspace, then the start command. For example:

```sh
npx --yes --package="https://your-workspace.example/downloads/multicode-ai-runner.tgz" multicode-ai-runner pair --server "https://your-workspace.example" --code RN-XXXX-XXXX
npx --yes --package="https://your-workspace.example/downloads/multicode-ai-runner.tgz" multicode-ai-runner start
```

These commands download the runner automatically and work from any folder,
without a global installation, administrator access or changes to PATH.
Use the complete command, including the package URL; this package is distributed
by your workspace, not published on the npm registry.
The package contains the compiled runner
and requires no application checkout, database, Redis or npm registry account.
Pairing codes expire after ten minutes and can only be used once. Keep the
runner terminal open while working; press Ctrl+C to stop it. Pair once, then use
the start command whenever you reconnect. If you are already paired, just start.

On Windows, install Git for Windows with command-line access enabled, then open
a new Command Prompt or PowerShell window before starting the runner. If
PowerShell blocks `npx.ps1`, use `npx.cmd` in the same pairing/start commands.
Install and sign in to your AI CLI in that same Windows environment. A CLI
installed only inside WSL needs a runner started inside WSL too. Custom Claude
Git Bash settings (`CLAUDE_CODE_GIT_BASH_PATH`) are preserved. The runner enables
Git long-path support for its own repositories without changing global settings.

After a runner update, stop the old process and copy the current start command
from **Your computers** to download the new build. Existing pairing and worktrees
are kept.

If an older instruction produces `multicode-ai-runner: command not found`,
use the full `npx` commands above. If `npx` itself is not found, install Node.js
and open a new terminal. You do not need to run `sudo npm install`.

Other commands use the same prefix:

```sh
npx --yes --package="https://your-workspace.example/downloads/multicode-ai-runner.tgz" multicode-ai-runner --help
npx --yes --package="https://your-workspace.example/downloads/multicode-ai-runner.tgz" multicode-ai-runner --version
npx --yes --package="https://your-workspace.example/downloads/multicode-ai-runner.tgz" multicode-ai-runner workspaces
```

The default workspace directory is `~/multicode-ai/workspaces`, with one
worktree per room repository, created on its first local AI task. To choose a
different location, add `--workspaces /absolute/path` when pairing. Configuration
is stored at `~/.config/multicode-ai/runner.json`; treat it as a private
credential. Never share its token.

Parallel chats each get a worktree of their own, so several AI tasks can run at
once: every task you start runs, with no cap. To limit it on this computer,
use `start --parallel <n>`. When those
chats are merged or discarded, `workspaces prune` lists their worktrees and
`workspaces prune --apply` removes the clean ones. Nothing is deleted
automatically.

The terminal panel in the workspace opens shells on this computer, in your
chat's worktree, while the runner is running. Only you can open them. Start with
`--no-terminal` (or set `RUNNER_TERMINAL=0`) to turn this off. A full terminal
uses Python 3, which ships with Git's developer tools on macOS; without it the
terminal is a basic shell.

MCP servers and plugins added under **AI tools** in the workspace are given
to each chat that uses them; your own Claude Code and Codex settings are not
changed. Keys those tools need stay on this computer: `secret set GITHUB_TOKEN`
asks for the value (or reads it from stdin), `secret list` shows the names and
`secret remove GITHUB_TOKEN` deletes one. They are kept in `secrets.json` in
the runner's data folder, readable only by you.

For local development the workspace address can be `http://localhost:3000`.
Use your deployed HTTPS workspace address when connecting another computer.

## Long tasks

A task runs as long as the agent keeps working, for hours if needed. It is
stopped only when the agent produces no output for `RUNNER_IDLE_MINUTES`
(default 30) or after `RUNNER_MAX_RUN_MINUTES` in all (default 480); time
spent waiting for you to answer a tool request counts towards neither. While a
task runs, the runner keeps the computer from sleeping (macOS `caffeinate`,
Windows `SetThreadExecutionState`, Linux `systemd-inhibit`). If the network
drops, the agent keeps working and the runner catches up when it is back; a
computer silent for 30 minutes is given up on and its work kept for review.

Each chat continues its own session with the AI tool on this computer (Claude
Code `--resume`, Codex `thread/resume`, Gemini CLI `--resume`), recorded in
`chat-sessions.json` in the runner's data folder, so the agent remembers
earlier turns. A chat whose session is not on this computer starts a new one,
given the conversation so far.

