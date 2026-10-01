# Multiplayer AI runner

The desktop app includes the runner and connects after sign-in. No Node.js,
npm command or application source checkout is needed for the desktop runner.
Git and the AI provider's CLI must be installed and signed in on your computer.

For browser users, install this standalone package once with Node.js 22 or
newer and npm. In **Your computers → Connect a computer**, copy the install
command for your workspace, then the pairing command. For example:

```sh
npm install --global https://your-workspace.example/downloads/multiplayer-ai-runner.tgz
multiplayer-ai-runner pair --server https://your-workspace.example --code RN-XXXX-XXXX
multiplayer-ai-runner start
```

These commands work from any folder. The package contains the compiled runner
and requires no application checkout, database, Redis or npm registry account.
Pairing codes expire after ten minutes and can only be used once. Keep the
runner terminal open while working; press Ctrl+C to stop it.

If the command is not found after installation, ensure npm's global executable
directory is on PATH (`npm prefix -g`, followed by `/bin` on macOS/Linux; the
prefix itself on Windows). Use a user-owned Node installation if global install
reports a permission error.

```sh
multiplayer-ai-runner --help
multiplayer-ai-runner --version
multiplayer-ai-runner workspaces
```

The default workspace directory is `~/multiplayer-ai/workspaces`, with one
worktree per room repository, created on its first local AI task. To choose a
different location, add `--workspaces /absolute/path` when pairing. Configuration
is stored at `~/.config/multiplayer-ai/runner.json`; treat it as a private
credential. Never share its token.

For local development the workspace address can be `http://localhost:3000`.
Use your deployed HTTPS workspace address when connecting another computer.
