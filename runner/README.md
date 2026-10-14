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

For local development the workspace address can be `http://localhost:3000`.
Use your deployed HTTPS workspace address when connecting another computer.
