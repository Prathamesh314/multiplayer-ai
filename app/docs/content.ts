/** Public user guides. Keep instructions tied to labels in the shipped UI. */
export type GuideSection = { id: string; title: string; body: string; screenshot?: string };
export type Guide = { slug: string; category: string; title: string; description: string; sections: GuideSection[] };
export const categories = ["Get started", "Your workspace", "Work with AI", "Work together", "Manage & troubleshoot"];

export const guides: Guide[] = [
  {
    slug: "prerequisites", category: "Get started", title: "Prerequisites",
    description: "Know what you need before downloading, joining, or running your first AI task.",
    sections: [
      { id: "choose-your-path", title: "Choose how you’ll participate", body: `Multicode AI is a shared coding workspace. The website stores collaboration and saved work; a connected computer runs your AI tools. A cloud AI provider can still process requests remotely.

| What you want to do | What you need |
| --- | --- |
| Read a shared AI conversation | A current browser, internet access, an account, and a valid invitation |
| Leave feedback | The above, with **Can comment** permission |
| Browse a project’s saved files and chats | An account with access to that project or room |
| Send AI prompts, even without files | Edit access, a connected computer, Git, and one installed and configured AI tool |
| Use the standalone computer connection | Node.js **22 or newer**, npm/npx, Git, and an AI tool |

You can join as a reader or commenter before setting up a computer. A guest invitation does not give editing access. See [sharing and guest access](/docs/sharing).` },
      { id: "computer", title: "Prepare your computer", body: `1. Use a computer that can stay awake and online while tasks run.
2. Install **Git** and confirm that \`git --version\` works in a new terminal. Get it from [Git’s download page](https://git-scm.com/downloads).
3. Install one supported AI command-line tool and complete its own sign-in or provider configuration. Signing in to Multicode AI with Google does **not** sign you in to an AI provider.
4. Have enough disk space for your repositories, dependency installations, and build output. Those files use your computer’s storage.
5. Install the desktop app, or use the [standalone runner](/docs/connect-computer#terminal-connection).

The desktop app includes its runner and Node runtime. You do not need to clone our source code, install our server, or install Node.js just for the desktop runner. An AI tool’s installer may have its own Node.js or other requirements.

There is no published universal RAM minimum for all projects. A small cloud-backed task and a large build have different needs. Optional local models have additional RAM/VRAM requirements set by their model and runtime; they are not required to get started.` },
      { id: "platforms", title: "Operating systems and downloads", body: `The [download section](/#download) lists available builds for **macOS Apple Silicon**, **macOS Intel**, **Windows x64**, and **Linux x64**. Choose the build for your processor. An unavailable build is labeled **Coming soon**.

The website lists Windows 10 or later; operating-system support also depends on the chosen desktop release and AI tool. On a Mac, **About This Mac** shows whether you have an Apple chip or Intel processor. The Linux download is an AppImage.

Preview builds are labeled on the download page. macOS previews are not notarized and Windows previews are unsigned; your operating system may block installation. Follow the [installation guide](/docs/download-install) and your organisation’s device policy.` },
      { id: "accounts-and-network", title: "Accounts, access, and connectivity", body: `Use your own AI provider account or configured provider credentials. That provider’s subscription, credits, permissions, and rate limits apply. Multicode AI does not include unlimited AI usage just because you created an account.

Your computer needs access to **https://multicode.in** and to the services used by your AI tool. A network that blocks streaming connections may interrupt live updates or computer pairing. Ask your network administrator about the workspace domain if connections repeatedly fail.

Imported files are uploaded to the workspace, and authorised teammates can access shared content. Prompts and selected context may reach your AI provider. Use sample files for your first task and keep credentials out of shared messages and uploads.` },
      { id: "ready-check", title: "Check that you’re ready", body: `Before sending your first prompt, confirm:

- You can sign in and open your project’s room.
- **Your computers** shows an online computer under the same account.
- **Connect your AI** shows an installed, configured execution option.
- The composer has an available provider and model selected.
- You have edit access and control of the conversation.

Then follow [your first AI conversation](/docs/first-conversation).`, screenshot: "providers" },
    ],
  },
  {
    slug: "download-install", category: "Get started", title: "Download & install",
    description: "Install the desktop app on macOS, Windows, or Linux and connect it to your workspace.",
    sections: [
      { id: "download", title: "Get the correct installer", body: `1. Open the [official download section](/#download).
2. Choose your operating system and processor. For macOS, choose **Apple Silicon** or **Intel Mac**; Windows and Linux downloads are x64.
3. Download the installer. If a platform says **Coming soon**, use the browser and the [standalone runner](/docs/connect-computer#terminal-connection) when you need AI execution.
4. If **Verify download checksums** is available, compare your file’s SHA-256 digest with that release’s checksum file.

Read the preview notice beside the download buttons. A preview is not a signed production release. Downloads and availability come from the homepage; these docs deliberately do not pin an installer version.` },
      { id: "macos", title: "Install on macOS", body: `1. Open the downloaded **.dmg**.
2. Drag **Multicode AI** into **Applications**.
3. Launch it from Applications.
4. If macOS blocks a preview build, confirm that it came from the official download page and consult your organisation’s policy or administrator. Do not disable system-wide security controls to run it.

A processor mismatch can stop the app from opening. Recheck **About This Mac** and download the corresponding Apple Silicon or Intel build.` },
      { id: "windows-linux", title: "Install on Windows or Linux", body: `**Windows:** open the downloaded **.exe**, follow the installer, and launch Multicode AI. An unsigned preview may trigger an operating-system warning. Use the release’s published provenance and your organisation’s installation policy to decide whether to proceed.

**Linux:** make the downloaded AppImage executable, then launch it. Replace the example filename with your actual downloaded filename:

\`\`\`sh
chmod +x ./Multicode-AI.AppImage
./Multicode-AI.AppImage
\`\`\`

If your distribution cannot run AppImages because FUSE is unavailable, the packaged AppImage supports:

\`\`\`sh
./Multicode-AI.AppImage --appimage-extract-and-run
\`\`\`

These commands install neither Git nor your AI tool. Complete the [prerequisites](/docs/prerequisites) separately.` },
      { id: "workspace-address", title: "Enter your workspace address", body: `On first launch, enter **https://multicode.in** in **Workspace address** and select **Connect**. Use only the origin: no \`/workspace\` path, invitation token, or trailing query string. For a privately hosted installation, use the HTTPS address supplied by its administrator.

The desktop app connects to an existing server; it does not create or host one. Sign in using the same account as the browser. The bundled runner connects automatically after sign-in.

Open **Your computers** in the workspace to confirm the device is online, then choose **Set up AI**.`, screenshot: "desktop-setup" },
      { id: "updates", title: "Update or reopen the app", body: `Open **Desktop settings** from the application menu, or use **Cmd/Ctrl + ,**. **Reopen workspace** retries the configured server. **Check for updates** uses the update feed configured for your build.

If updates are not configured, obtain a newer installer from the download page or your administrator. When an update is available, download and installation require confirmation. Save unsent drafts and pause the runner before installing. See [desktop settings and worktrees](/docs/desktop-settings).` },
    ],
  },
  {
    slug: "account", category: "Get started", title: "Create an account & sign in",
    description: "Use Google or email, verify your email, and keep invitation links through sign-in.",
    sections: [
      { id: "signup", title: "Create your account", body: `1. Select **Open workspace** on the homepage and choose the signup option on the sign-in page.
2. Use **Continue with Google** when available, or continue with email. Clerk manages sign-in, signup, verification, and recovery; the available methods follow the workspace’s authentication settings.
3. Complete any email verification step. You do not need a Gmail address for email/password signup.
4. Once signed in, create a team workspace or accept an invitation. If you arrived from an invitation, continue through that link so the app can return you to it.

The hosted workspace currently allows open signup. A privately hosted workspace may require an invitation or temporarily disable new accounts; follow the message on that sign-in page.` },
      { id: "verification", title: "Verify your email and manage your account", body: `Follow the verification instructions in the sign-in form. Check your inbox and spam folder, use the newest code, and follow the expiry and resend guidance shown by Clerk. Your email does not need to be a Google account.

If you already used Multicode AI before Clerk was introduced, sign in or create your Clerk account with the **same verified email address**. Your conversations and memberships stay attached to your account. Your previous application password is not transferred: use Google or email verification and manage your password in **Account settings**.

Open **Account settings** in your workspace to manage your profile, sign-in methods, password, multi-factor authentication, and active sessions. Account deletion removes your access and disconnects your computers. If an email is linked to another identity, contact your workspace administrator instead of creating duplicate accounts.` },
      { id: "invitation-signin", title: "Join from an invitation", body: `Open the complete invitation URL. If asked to sign in, use the account that should receive access. **Guest conversation links require the exact invited email.** For a new account, complete signup and email verification, then return to the invitation if you are not taken there automatically.

Accepting a team invitation and being added to a project are separate steps. If you can see the organisation but not the intended project, ask its manager to add you. See [members and permissions](/docs/members) and [guest sharing](/docs/sharing).` },
      { id: "returning", title: "Returning to your workspace", body: `Open [/workspace](/workspace), sign in using your existing method, and choose your organisation and project. **Shared with me** lists guest conversations available to your account.

Use the same account in desktop and browser. A computer connected to one account cannot execute prompts for a different account. Signing out of the desktop app stops new local tasks; an already accepted task is drained before shutdown.` },
    ],
  },
  {
    slug: "connect-computer", category: "Get started", title: "Connect your computer",
    description: "Connect automatically through desktop, or pair a standalone runner from a terminal.",
    sections: [
      { id: "desktop", title: "Connect with the desktop app", body: `1. [Install the desktop app](/docs/download-install) and connect to your workspace’s HTTPS address.
2. Sign in with the account you use in the browser. The app starts its bundled runner and pairs automatically.
3. Open **Your computers** from the workspace’s connection notice or computer icon.
4. Confirm your computer is online. Select **Next: Set up AI** to check your installed tools.

Keep the app running and the computer awake during tasks. Closing the browser does not move an active task to the server. If you want another teammate to continue, use [Handoff](/docs/handoff) and wait for the current turn to finish.`, screenshot: "computers" },
      { id: "terminal-connection", title: "Use a terminal instead", body: `This path requires **Node.js 22 or newer**, npm/npx, Git, and your installed AI tool. It works without an application source checkout.

1. In the browser, open **Your computers**.
2. Expand **Use a terminal instead (advanced)**.
3. Choose **Connect a new computer with commands**.
4. Copy and run the exact pairing command shown there. It includes your workspace’s runner-package URL and a fresh pairing code.
5. Copy and run the **start** command. Leave that terminal open while working.

Pairing codes are single-use and expire in **10 minutes**. Never publish or reuse a code from a screenshot. Pair once; on later visits, use the start command again.

For the hosted workspace, the start command is:

\`\`\`sh
npx --yes --package="https://multicode.in/downloads/multicode-ai-runner.tgz" multicode-ai-runner start
\`\`\`

Run it on the computer that should execute your tasks. The full package URL matters: the runner is distributed by your workspace. If \`npx\` is missing, install Node.js and open a new terminal.` },
      { id: "states", title: "Understand connection states", body: `| State | What to do |
| --- | --- |
| No computer connected | Open desktop and sign in, or pair the standalone runner |
| Offline | Wake the computer, restore internet access, and reopen desktop or run the start command |
| Update required | Install the latest desktop/runner build and reconnect |
| Connection check failed | Use **Check connection again**; inspect network access if it repeats |
| Connected, no AI tool ready | Open **Set up AI** and finish provider installation/login |

Saved chats and uploaded files remain readable with the correct permissions even when your computer is offline. Sending prompts needs a working execution option.` },
      { id: "remove-device", title: "Disconnect or revoke a computer", body: `Use **Your computers** to inspect or revoke a device. Revocation removes its permission to claim work; reconnect explicitly if you need that computer again. To pause temporarily, use **Pause after current task** in desktop settings or stop the standalone runner with **Ctrl+C**.

Each computer executes work for its owning account. Teammates do not gain control of your machine simply by joining a project. Your AI tool can run commands with your local user permissions when executing your tasks.` },
    ],
  },
  {
    slug: "ai-providers", category: "Get started", title: "Set up your AI tools",
    description: "Connect one provider, understand model discovery, and choose optional local execution modes.",
    sections: [
      { id: "connect", title: "Install and connect one tool", body: `1. Install Git and your chosen AI command-line tool on the connected computer. Use its official installer and sign-in instructions.
2. Run that tool directly in a terminal once and finish its login/provider setup.
3. In Multicode AI, open **AI providers**, **Set up AI**, or **Providers** inside a chat.
4. Select **Check connections**. If a detected tool offers **Connect**, follow its login flow; you can also complete the CLI login in your terminal.
5. Return to the room and choose its provider and model in the composer.

You only need **one** working tool. The app displays installation commands for missing tools and status for installed tools. It does not install every provider or purchase AI credits for you.`, screenshot: "providers" },
      { id: "options", title: "Available execution options", body: `| Option | Required setup | Behavior in this app |
| --- | --- | --- |
| Claude Code | Installed CLI and provider sign-in | Coding agent; available aliases or discovered models |
| Codex | Installed CLI and provider sign-in | Coding agent; models and reasoning efforts discovered from the CLI |
| Gemini | Installed CLI and its login/configuration | Coding agent; default or discovered models |
| OpenCode | Installed CLI and configured provider | Tool-capable text models from its provider configuration |
| Ollama | Running local server and an explicitly downloaded model | Chat-only option |
| Codex + Ollama | Codex plus a compatible model on the default Ollama server | Local coding through Codex’s OSS backend |
| Codex + LM Studio | Codex plus a compatible model served by LM Studio | Local coding through Codex’s OSS backend |

The last three are optional advanced choices. Model discovery does not download weights. Local coding quality and compatibility depend on the model, tool support, and available RAM/VRAM.

Use the live provider screen for the options actually available on your computer. A local client can still call a cloud service depending on its configuration.` },
      { id: "models", title: "Models, refreshes, and unavailable selections", body: `Open the searchable **Model** picker to see the connected tool’s current inventory. The picker can show its source, refresh time, and stale or error state. Use its refresh control after installing or updating a provider.

Availability depends on the installed tool and your account. If a selected model disappears, choose a currently available model explicitly. The app does not silently substitute a different or more expensive model.

Reasoning effort choices come from the selected model. **Fast** uses low effort only when supported. See [composer controls](/docs/ai-conversations#composer).` },
      { id: "provider-help", title: "Provider help and account limits", body: `Official setup references: [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://developers.openai.com/codex/cli/), [Gemini CLI](https://geminicli.com/docs/), [OpenCode](https://opencode.ai/docs/), [Ollama](https://docs.ollama.com/), and [LM Studio](https://lmstudio.ai/docs/).

Your provider controls billing and limits. A quota, expired login, or unavailable model error must be resolved with that provider or its local configuration. Refresh connections afterward. Never paste API keys or login tokens into shared chat.` },
    ],
  },
  {
    slug: "first-conversation", category: "Get started", title: "Your first AI conversation",
    description: "Go from a new account to a saved conversation, with or without a repository.",
    sections: [
      { id: "start", title: "Open a place to work", body: `1. Complete the [prerequisites](/docs/prerequisites), [computer connection](/docs/connect-computer), and [AI setup](/docs/ai-providers).
2. Open your organisation in the workspace. If you have no organisation yet, create one, or accept your team’s invitation.
3. Select **New project**, give it a name, and create it. If you lack that permission, ask an organisation owner/admin to create or invite you to a project.
4. On the project card, choose **Open my room**.

A project is the team’s shared home. A room is your place to work inside it. A repository is an optional collection of files inside a room.` },
      { id: "without-files", title: "Start without files", body: `Select **Start without files** in the empty room, or open **Add repository → Start without files**. Name your conversation space and select **Create conversation space**.

This creates a place for saved AI chats without requiring a folder upload. Computer and provider setup are still required to send messages. You can use this for planning, questions, or brainstorming.`, screenshot: "empty-project" },
      { id: "send", title: "Send a small first request", body: `Choose a provider and available model in the composer. Try:

> Help me plan a simple task tracker. List the main user actions and suggest a small first milestone. Do not create files yet.

Press **Send** or **Enter**. Use **Shift+Enter** for a new line. Wait for the response, expand its activity if needed, and ask a follow-up. The conversation appears under its repository or conversation space in the left sidebar.

If sending is unavailable, read the message above the composer: it distinguishes a missing computer, missing AI setup, view-only access, and another person driving the chat.`, screenshot: "conversation" },
      { id: "next", title: "Continue with files or teammates", body: `To work with code, [import a folder](/docs/repositories). To create a separate AI chat, use the **+** beside its repository or conversation space. To let someone read or comment, choose [Share chat](/docs/sharing). To transfer the same conversation, use [Handoff](/docs/handoff).

Inspect [Changes](/docs/files-changes) after coding tasks. Treat an AI’s claim that a task is done as something to verify with review and tests.` },
    ],
  },
];

guides.push(
  {
    slug: "projects-rooms", category: "Your workspace", title: "Projects, rooms & navigation",
    description: "Understand the hierarchy and find your own work or a teammate’s room.",
    sections: [
      { id: "hierarchy", title: "How the workspace is organised", body: `| Level | Purpose |
| --- | --- |
| Organisation | Your team, its membership, and administration |
| Project | A collaboration space containing rooms, shared repositories, and project context |
| Room | A member’s working space, with its own access rules and repository checkouts |
| Repository / conversation space | Files for a particular codebase, or a starting point without files |
| AI chat | A conversation targeting one selected room repository or conversation space |

A project can have no repositories or several repositories. A chat targets one selected repository; selecting another repository does not make the chat operate across all repositories.`, screenshot: "workspace" },
      { id: "navigate", title: "Find and open your work", body: `Choose an organisation in the left rail. The **Projects** view shows its projects, and **Search projects** filters the cards. Expand a project in the sidebar to see accessible rooms. **Search rooms** helps find a room by name.

Choose **Open my room** on a project card to enter your working space. Viewers see **View a room**. Rooms initially use their owner’s name and can be renamed in **Room privacy & members**.

Inside a room, expand **Repositories & chats** groups and select a conversation. The **+** next to a repository starts a new chat. The toolbar’s back and forward arrows navigate page history; **Back to projects** returns to the workspace.` },
      { id: "room-layout", title: "The four room panels", body: `- **Left:** repositories, conversation spaces, AI chats, and teammate navigation.
- **Centre:** the active AI conversation or file contents. The chat header carries **Briefing**, **Activity & checkpoints**, and **Providers**, so the conversation itself stays prompts, replies, and tool calls.
- **Top right:** **All files** and **Changes**, with task assignment, handoff, and AI review actions.
- **Bottom right:** the terminal panel, when opened. Interactive shell availability depends on the environment.

Drag the panel dividers to resize the workspace. Each area scrolls independently. On smaller windows, some controls wrap or panels collapse; use their visible controls to reopen them. **Room guide** offers a short walkthrough.`, screenshot: "conversation" },
      { id: "visibility", title: "Public and private rooms", body: `A **public** project room is visible to members of that project; it is not publicly accessible on the internet. A **private** room requires explicit room access.

Open the room’s **Room privacy & members** settings from the project sidebar to review its name, visibility, and members. Only authorised users can change these settings. Review the scope before sharing a repository from a private room: sharing it makes that saved code available to the project.` },
    ],
  },
  {
    slug: "repositories", category: "Your workspace", title: "Import & share repositories",
    description: "Bring in a folder, start without files, or use a repository already shared with your project.",
    sections: [
      { id: "import", title: "Import a folder", body: `1. Open your room and select the folder-plus **Add repository** control.
2. Choose **Import folder** and select the folder on your computer.
3. Allow the upload to finish. The repository appears in the sidebar and its files become available in **All files**.
4. Select it before starting a chat or inspecting changes.

Import copies supported files into the app’s managed repository. It is not a live link to your original folder, and it does not automatically connect a GitHub remote. Dependency/build folders and other excluded paths are filtered by the importer. Check the uploaded tree before asking AI to work.

Keep passwords, tokens, and private environment files out of the folder you share. Folder import and composer attachments are different operations: attachments add text to a prompt.`, screenshot: "add-repository" },
      { id: "empty", title: "Use a conversation space without files", body: `Choose **Start without files**, give the space a name, then **Create conversation space**. You can create several chats under it with the **+** button. No folder upload is required.

This option removes the repository-upload step. It does not remove the computer and AI-tool prerequisites for sending prompts. See [your first conversation](/docs/first-conversation).` },
      { id: "share-repository", title: "Share a repository with the project", body: `An imported repository initially belongs to its room. To make its saved code available across the project, select it and choose **Share repository**. Review what is being shared, especially if the source room is private.

Other project members can then open **Add repository → Project repositories** and select **Add to room**. Each room receives its own checkout and saved history. Adding one repository does not automatically add the rest.

Only people with project access can browse the shared repository catalog. A room invitation alone does not grant access to every repository in the project.`, screenshot: "project-repositories" },
      { id: "sync", title: "Keep shared code up to date", body: `Use **Get latest** to bring the selected shared repository’s saved project changes into your room. Use **Publish** to share your room’s saved changes back to that project repository.

Both actions operate on the selected repository. They do not push to GitHub or create a pull request. Inspect [Changes](/docs/files-changes), run appropriate checks, and resolve any reported conflict before trying again.` },
    ],
  },
  {
    slug: "files-changes", category: "Your workspace", title: "Files, changes & publishing",
    description: "Read and edit files, inspect saved changes, and share the selected repository’s work.",
    sections: [
      { id: "files", title: "Browse and edit files", body: `Open **All files** in the top-right panel, use **Find a file or folder…** to filter the tree, expand a folder, and select a file. Its contents open in the centre viewer. Open files use tabs so you can return to the conversation or switch files.

Text files can be edited when you have write access. The editor saves changes through the workspace. Wait for saving to finish and address any error before navigating away. Binary or oversized content may be shown with a limitation message rather than an editable document.

Teammate avatars and editing indicators help you see who is present and working on a file; they are not exclusive editing locks.

The browser’s file editor works on the room’s saved files. An active AI task has its own local worktree; coordinate concurrent edits and inspect conflicts rather than assuming one silently replaces the other.`, screenshot: "files" },
      { id: "changes", title: "Inspect the Changes tab", body: `Select **Changes** to see added, modified, deleted, or renamed paths in the selected repository. Open a changed file to inspect its current contents. Deleted files are not openable from this list. For uploaded checkpoint diffs, use [Activity & checkpoints](/docs/history). Counts reflect saved application data, not every unsaved file on another computer.

After an AI turn, check the requested behavior, changed files, and test output. **Ask AI to review** prepares a review prompt in the composer; you still decide whether to send it. For recorded human approval, use [Teammate review](/docs/reviews).`, screenshot: "changes" },
      { id: "publish", title: "Publish saved changes", body: `1. Select the intended repository.
2. Inspect Changes and finish any local or editor saves.
3. If this is a room-only import, use **Share repository** first when you want a project repository.
4. Select **Publish** to share saved work with that project repository.
5. Teammates select **Get latest** in their rooms to incorporate it.

Publish is an in-app collaboration action. It does not create a GitHub pull request, merge an external repository, or automatically run a teammate review. An approved review also does not publish changes for you.` },
      { id: "conflicts", title: "When saving or syncing conflicts", body: `Read the error before retrying. Another writer or a newer shared version may have changed the repository. Preserve your draft or local changes, inspect the current state, and reconcile conflicting work before publishing again.

If the driver’s computer went offline, [Activity & checkpoints](/docs/history) shows only work that was uploaded. Do not treat an unsynced local edit as available to the rest of the team.` },
    ],
  },
  {
    slug: "terminal", category: "Your workspace", title: "Terminal",
    description: "Open a shell on your own computer, in the worktree of the chat you are in, from the browser or the desktop app.",
    sections: [
      { id: "hosted", title: "A terminal on your computer", body: `The terminal panel opens a shell **on your connected computer**, like your AI tasks: in the worktree of the chat you are viewing, with your own tools, Git setup and signed-in AI command-line tools. It works the same from the browser and the desktop app; the website only relays keystrokes and output.

The panel header names the computer, for example **Your computer · Alice’s Mac**. Each tab stays in the worktree it opened in: a parallel chat’s own worktree, otherwise the room’s. Open a chat and select **+** for a terminal in that chat’s worktree. If that chat has not run on this computer yet, the terminal opens in your home folder and says so; its worktree is created by the first AI task there.

If no computer is connected, the panel says so. Open the desktop app or [start the runner](/docs/connect-computer), then select **Check again**. A reloaded page reattaches to a running shell for about a minute.`, screenshot: "terminal" },
      { id: "local", title: "Full terminal, privacy and turning it off", body: `Full-screen programs, colours and Tab completion use a real terminal through Python 3, which is present wherever Git’s developer tools are installed on macOS and on most Linux systems. Without it, and on Windows for now, the terminal is a basic shell and says so.

Only you can open terminals on your computers. To stop a computer hosting them, start the runner with \`--no-terminal\`, set \`RUNNER_TERMINAL=0\`, or add \`"terminal": false\` to its configuration.

A development server that cannot reach runners at all (for example without Redis) opens the shell on the machine serving the application instead, and the header says **This server**. Do not expose such a server terminal publicly.` },
    ],
  },
  {
    slug: "ai-conversations", category: "Work with AI", title: "Conversations & composer controls",
    description: "Choose a model, attach context, read tool activity, and continue or fork a conversation.",
    sections: [
      { id: "new-chat", title: "Create or reopen a chat", body: `Choose a repository or conversation space and use its **+** button to create a new AI chat. Click an existing chat in the sidebar to load its saved conversation. You can read a teammate’s chat when you have access; only the current driver can continue that same chat.

The centre panel distinguishes human prompts from AI responses. Tool activity and message totals come from the conversation data. Expand a response’s steps to inspect available commands, tools, and output. A recorded tool call is evidence of an attempted action, not proof that the final result is correct.`, screenshot: "conversation" },
      { id: "composer", title: "Use the composer controls", body: `| Control | What it does |
| --- | --- |
| Provider | Chooses the installed AI tool that will execute your request |
| Model | Searches available models reported by that tool |
| Reasoning effort | Selects one of the selected model’s supported effort levels |
| Fast | Selects low reasoning effort when supported; unavailable otherwise |
| Plan | Adds an instruction asking for a plan before changes; it is not a separate security sandbox |
| Attach files | Reads supported text/code files into the draft prompt |
| Send | Sends the current draft using the selected setup |

The pickers open above the composer. Use search where available, arrow keys to choose an option, Enter to select, and Escape to close. Model names and effort choices can differ by account, tool version, and connected computer.

Use **Enter** to send and **Shift+Enter** for a newline. Starter prompts only fill or guide the draft; choosing a starter does not run an agent.`, screenshot: "model-picker" },
      { id: "context", title: "Attach files and reference conversations", body: `The attachment control accepts UTF-8 text/code files up to **100 KB per file**. Their contents are inserted into the prompt draft. It is not an image upload, repository import, or a way to attach unlimited binary files. Review the draft before sending.

Type **@** to select an available room/chat reference from the picker. Pick an actual result so the app can resolve its context; simply typing another person’s name is not the same as selecting a conversation reference. Where shown, **Import context from…** starts a new chat using another accessible conversation’s context.

Context is limited by access and prompt budgets. The system cannot give your AI unrestricted access to every private room.` },
      { id: "fork", title: "Fork instead of taking control", body: `When watching a teammate’s chat, **fork a new chat** creates your own conversation with imported context. It leaves the original chat and driver intact.

A fork is not automatically a new repository branch: chats in the same room repository share that room’s worktree. For independent code work, use your own room checkout of a shared repository. Use [Handoff](/docs/handoff) when you want to continue the original conversation itself.` },
      { id: "organise", title: "Rename, archive, or reference a chat", body: `Hover a chat row to reveal its available actions. **Rename** changes its title. **Archive this chat** moves an eligible chat out of the active list; expand **Archived** and use **Restore this chat** to bring it back. Management actions depend on who drives the chat and its current state.

**Copy chat path** copies a room/chat reference for use in another conversation. It is a context reference, not a guest invitation and not a way to grant access. Use Share chat when someone outside the room needs to read it.` },
      { id: "during-work", title: "While a task is running", body: `Follow the streamed response and expand available activity. **Queue message** lets the driver add instructions while work is active. **Detach**, when shown, detaches the view; do not assume that closing the view stops the underlying task.

Read [queued instructions](/docs/queued-messages) for provider-specific timing, and [history and checkpoints](/docs/history) for recovery after a disconnect.` },
    ],
  },
  {
    slug: "queued-messages", category: "Work with AI", title: "Queue instructions during a run",
    description: "Send follow-up guidance while AI is working and understand delivery status.",
    sections: [
      { id: "queue", title: "Add or remove an instruction", body: `While you are driving an active chat, use **Queue message** below the conversation. Write the additional instruction and submit it. The queue shows its status, and teammates can see the queued work.

You can remove a message before the executor claims it. Once claimed, it may already be reaching the AI tool. Only the current driver with edit access can send or cancel queued instructions.`, screenshot: "queued-messages" },
      { id: "timing", title: "When the provider receives it", body: `**Codex:** the integration can steer its active app-server turn. The tool decides when the instruction is consumed; it cannot retroactively change a command already executing. If the response has just finished, the instruction may start another turn.

**Other supported CLI providers:** queued instructions wait until the current process finishes and then run in order with prior conversation context. The interface describes this as **queued for the next response**.

A delivery acknowledgement means the instruction was submitted, not that the requested result has been achieved.` },
      { id: "retry", title: "Handle a failed or unconfirmed instruction", body: `If a task fails or is recovered after a disconnect, a queued instruction may be marked failed or unconfirmed. Inspect the transcript and saved activity before resending. Unconfirmed messages are not automatically replayed because they might already have affected the work.

If the turn finishes while you submit, the app may reject the late instruction and preserve your draft. Send it as a normal next prompt after reviewing the completed result.` },
    ],
  },
  {
    slug: "history", category: "Work with AI", title: "Activity & checkpoints",
    description: "Inspect uploaded work, compare checkpoints, and prepare a safe continuation after a disconnect.",
    sections: [
      { id: "activity", title: "Read synchronized activity", body: `Open an AI conversation and select **Activity & checkpoints**. The dialog shows when activity last synchronized. Select a turn to read uploaded activity and use **Load next activity** for additional output.

This history remains available when the driver’s computer is offline. It only contains activity that reached the server; it does not reveal unsynced work still on that computer.`, screenshot: "history" },
      { id: "checkpoint", title: "Inspect and select a checkpoint", body: `1. Open the **Code checkpoint** picker.
2. Choose an uploaded checkpoint and inspect the listed files and diff.
3. Confirm that you are the current driver and the chat has no running or queued turn.
4. Select **Use checkpoint for next turn**.
5. Review your next prompt and send it when ready.

Selection alone does not run an agent or immediately restore files. The next prompt restores the selected checkpoint locally. Existing local edits can block restoration, so preserve and resolve them first. Staged and unstaged changes are tracked separately.` },
      { id: "recovery", title: "Recover interrupted work", body: `If the driver is unavailable or a turn is abandoned, a room owner may use **Recover unavailable driver / abandoned turn** in the handoff dialog when the server permits recovery. Recovery does not magically recover unsynced files or migrate a live process.

After recovery or an accepted handoff, read the conversation, inspect uploaded checkpoints, and explicitly send the next prompt. A stale or conflicting action can be rejected; refresh the current state before retrying.` },
    ],
  },
  {
    slug: "briefings-memory", category: "Work with AI", title: "Conversation briefings & memory",
    description: "Catch up from recorded evidence and review what the team’s AI should remember.",
    sections: [
      { id: "briefing", title: "Start with the conversation briefing", body: `Select **Briefing** in the chat header when entering a chat. It organises the goal, accepted decisions, recorded progress, blockers/checks, and next action. **Source evidence** shows what the draft is based on.

The initial briefing is assembled from recorded activity. It distinguishes AI-reported work from saved changes and approved decisions. It is a starting point to review, not a guarantee that the task is finished.`, screenshot: "briefing" },
      { id: "edit", title: "Edit and update a briefing", body: `Choose **Edit briefing**, correct the fields, and select **Save briefing**. If sources changed, **Needs updating** prompts you to check them. **Refresh evidence, keep draft** updates the source version while preserving your draft; **Replace draft from sources** rebuilds it.

Concurrent edits can require a refresh. Review the current evidence before saving again.

Only the chat host can publish a briefing and its evidence to guests using the explicit sharing checkbox. Inspect it first: evidence may include workspace decisions or saved-change details.` },
      { id: "memory", title: "Review room memory", body: `Select **Room guide** in the room toolbar, then **Review room memory**. Select a record and inspect **Source evidence**, **Open source chat**, related memories, and review history.

Completed conversations can create historical episodes. An approved episode records that an exchange happened; it does not certify every AI assertion. Facts and procedures need review before they become approved guidance.

With edit permission, turn an exchange into a fact or procedure, enter what the team should remember, and **Save proposal**. Review its evidence before approving it. You can retract an incorrect memory, replace an old decision through the available approval controls, or **Link code change** to a verified implementation.`, screenshot: "memory" },
      { id: "scope", title: "What AI can recall", body: `Memory recall respects the user’s room access and the record’s approval and source state. Proposals, retracted claims, and superseded decisions are not treated as current approved facts. Project-code episodes may wait for their exact saved changes to be published.

Background indexing or optional extraction may be pending. The memory dialog shows that state; manually reviewed evidence remains available. Updating memory does not undo code changes or erase already-visible chat messages.` },
    ],
  },
  {
    slug: "parallel-chats", category: "Work with AI", title: "Run chats in parallel",
    description: "Give several AI chats their own branches, review each one, and merge the work you want.",
    sections: [
      { id: "when", title: "When to use a parallel chat", body: `An ordinary chat works directly on the room's branch, so you run one at a time in a room. A **parallel chat** works on a branch of its own, forked from the room when it starts. Several can run at once on the same repository, each in its own folder on your computer, without changing each other's files.

Use parallel chats to try alternatives side by side, or to split independent tasks across agents. Each one's work reaches the room only when someone merges it.

Parallel chats are available when the workspace administrator has turned them on. If you don't see **Parallel** in the composer, they are off for this workspace.` },
      { id: "start", title: "Start a parallel chat", body: `1. Choose the repository and select **New chat**.
2. In the composer, turn on **⑂ Parallel**. It stays on for your next new chat, so you can start several in a row.
3. Write the task and send it.

The setting applies when a chat starts; an existing chat keeps the kind it was started as. Your [connected computer](/docs/connect-computer) needs the current desktop app or runner. An older one is asked to update instead of running the chat. There is no limit on how many parallel chats run at once: each runs on your computer, with your own AI account. Your workspace's hourly and monthly limits still apply.` },
      { id: "review", title: "Review a parallel chat's changes", body: `In the sidebar, a parallel chat shows **review** when it has changes to merge, **merged** once its work is in the room, or **discarded** when set aside.

Open the chat and select **Changes**. The panel shows how many commits the chat is ahead of and behind the room, every changed file with its added and removed lines, and a line-numbered diff for the file you select. Everyone who can open the room can review; only room editors can merge.` },
      { id: "merge", title: "Merge into the room", body: `Select **Merge into room**. The merge only happens if neither the chat nor the room has changed since you opened the panel; otherwise refresh and review the latest changes first. It is recorded as a merge in the room's history, which keeps each turn's commit traceable.

Merging changes the room's branch only. Use [Publish](/docs/files-changes#publish) to share the result with the project repository, as with any other room change. If the chat continues after a merge, its new work becomes a new proposal to review.` },
      { id: "update", title: "Bring in the room's latest work", body: `When the room has moved on, the chat's driver can select **Update from room** to merge the room's newer changes into the chat's branch, so the chat continues from them and merges cleanly later.

If the room and the chat changed the same lines, nothing is changed and the panel lists the files. Select **Bring in changes and ask the agent** to bring the room's changes into the chat's branch with conflict markers and place a prompt in the composer asking the agent to resolve them. Review and send it. Until every marker is resolved, the chat can't be merged and the panel flags the affected files. The room never receives conflict markers.` },
      { id: "discard", title: "Discard, reopen, and clean up", body: `The chat's driver or the room owner can **Discard** a parallel chat. Its branch and history are kept, it stops taking new prompts, and **Reopen** brings it back.

Each parallel chat has its own folder on the computer that runs it. Nothing is deleted automatically. After chats are merged, discarded, or archived, run \`multicode-ai-runner workspaces prune\` to list their folders, then add \`--apply\` to remove the ones with no unsaved edits whose commits the workspace already has. Removal includes installed dependencies in those folders. Room folders are never pruned.` },
    ],
  },
);

guides.push(
  {
    slug: "members", category: "Work together", title: "Invite members & manage access",
    description: "Bring people into your organisation, add them to a project, and choose the right scope.",
    sections: [
      { id: "choose-scope", title: "Choose the invitation that fits", body: `| Intended access | Use |
| --- | --- |
| Read or comment on one AI conversation | **Share chat** — a guest does not need to join the organisation |
| Join the team | **Invite team** / **Invite people**, then project membership as needed |
| Enter a whole room as an existing team member | The room’s **Invite** controls |
| Continue driving an AI conversation | Editing access first, then **Handoff** |

Do not use a broad team or room invitation when a person only needs to comment on a single conversation. See [Share chat](/docs/sharing) for that smaller scope.` },
      { id: "invite-team", title: "Invite someone to the organisation", body: `Organisation owners/admins can open **Invite team** on the project overview or the **Invite people** icon beside the organisation name.

1. Choose email invitation for a new person, or the connect-code option for an existing app account.
2. Choose the intended role. Use **member** for normal participation; **admin** grants organisation administration.
3. Generate the invitation and copy the displayed link for an email invite. Send it to the person yourself; creating this link does not automatically send an invitation email.
4. The recipient opens the link, signs in or creates an account, and accepts it.

An organisation email invitation expires **14 days after creation** and is single-use. Generating a replacement for the same email in that organisation revokes the previous pending link. Expiration prevents later acceptance; it does not remove membership already granted.`, screenshot: "invite-team" },
      { id: "project-members", title: "Add the person to a project", body: `After the person joins the organisation, open the project’s **Members** dialog. Choose a role and add them from **Add from organisation**.

| Project role | Intended use |
| --- | --- |
| Viewer | Read accessible project rooms and saved work |
| Editor | Work with repositories and run AI with their own configured computer |
| Manager | Manage project membership and project-level collaboration |

Project membership and organisation membership are separate. If the person joined the team but cannot find a project, check this dialog first. A private room can still require an explicit room invitation.`, screenshot: "project-members" },
      { id: "room-access", title: "Invite to a room or change visibility", body: `Use **Invite** in the room toolbar for whole-room access. In organisation rooms, these links are for existing organisation members. The dialog offers view/edit access; check the scope before copying a link.

From the project sidebar, open **Room privacy & members** to inspect the room’s name, public/private visibility, and explicit members. Public means accessible within the project. Room access does not automatically add a person to the project’s other repositories.` },
      { id: "remove", title: "Change or remove access", body: `Authorised managers can change project roles or remove project members. Organisation owners/admins can manage roles, suspend/reactivate members, or remove them through **Organisation admin**. The interface prevents actions you are not authorised to perform.

Removing one type of invitation is not the same as removing every permission a person holds. Review organisation, project, room, and guest access separately. Revoking a guest link does not automatically remove editing membership granted later.` },
    ],
  },
  {
    slug: "sharing", category: "Work together", title: "Share a chat with a guest",
    description: "Invite someone outside your organisation to read or comment on one conversation.",
    sections: [
      { id: "create-link", title: "Create and send a guest link", body: `The chat host can open **Share chat** in an existing AI conversation.

1. Enter the guest’s email address.
2. Choose **Can view** or **Can comment**.
3. Select **Create invitation link**.
4. Select **Copy link** and send the complete link to your guest.

The link includes an invitation fragment. Do not remove the part after \`#invite=\`. The guest signs in with the exact invited email, or creates and verifies an account for it. Creating a link does not automatically email it.`, screenshot: "share-chat" },
      { id: "guest-scope", title: "What the guest can see", body: `A guest can read that chat’s existing and future human/AI messages, including code or sensitive text included in those messages. **Can comment** also enables feedback. Other chats, repository files, tool access, and workspace settings are not automatically shared.

A host can separately publish the conversation briefing and its evidence. Review that content before enabling guest visibility.

Guest access lasts **7 days from invitation creation**, or until revoked. A replacement invitation replaces the same person’s previous chat access. This is different from the 14-day organisation invitation. Accepted guest chats appear in **Shared with me**.` },
      { id: "feedback", title: "Read and respond to feedback", body: `Guests with commenting permission write in the shared conversation’s feedback area. Hosts and authorised teammates can open **Feedback** directly in the room’s chat. The workspace **Collaboration inbox** links to unread feedback and review requests.

Use **Preview shared chat & reply to comments** if you want to inspect the guest-facing view. See [feedback and inbox](/docs/feedback) for the direct reply flow.` },
      { id: "revoke", title: "Revoke or renew a guest invitation", body: `Open **Share chat** again to see **Waiting to join**, **Joined**, **Expired**, or **Access removed** status. Use **Revoke chat invitation** to remove that grant. To extend access, create a new invitation for the intended email and send the new link.

Revocation stops future access through that invitation; it cannot recall text someone already saw. If you separately granted project or room editing access, manage that membership separately.` },
    ],
  },
  {
    slug: "guest-to-editor", category: "Work together", title: "Let a guest help with code",
    description: "Preview and explicitly grant additional access before offering control of the chat.",
    sections: [
      { id: "grant", title: "Promote an accepted guest", body: `1. Ask the guest to accept the conversation invitation first.
2. Open **Share chat** and find their active, accepted invitation.
3. Select **Allow guest to help with code…**.
4. Read the access preview. It lists the organisation, project, and room permissions that would be added.
5. If you have authority, check **I approve the additional access described above** and select **Grant editing access**.

Do this only when the broader scope is appropriate. The guest may gain access to more than the shared transcript. The preview describes the actual scope rather than silently granting it.`, screenshot: "guest-access" },
      { id: "admin", title: "Request an admin’s approval", body: `If you cannot grant all required permissions, use **Request admin approval** after reviewing the scope. The request appears in the organisation admins’ **Collaboration inbox**. Until approved, the person keeps their existing chat-only access.

An authorised admin reviews the request and can grant or decline it. Access is checked again when the action is submitted, so a changed membership or scope can require refreshing the preview. Suspended or removed accounts are not automatically reactivated by this flow.` },
      { id: "continue", title: "Offer handoff after access is granted", body: `Editing access alone does not transfer chat control or start AI. The new editor can open the workspace from the shared chat. They must [connect their own computer](/docs/connect-computer) and configure an AI tool to execute prompts.

Use [Handoff](/docs/handoff) to offer the original conversation to them. They accept control after the current turn finishes, review the briefing and saved work, and decide when to send the next prompt.` },
    ],
  },
  {
    slug: "handoff", category: "Work together", title: "Hand off an AI conversation",
    description: "Transfer control to a teammate at a safe turn boundary, keeping saved context intact.",
    sections: [
      { id: "before", title: "Before you hand off", body: `The recipient must already have room editing access. For an outside guest, first follow [Let a guest help with code](/docs/guest-to-editor). To run the next prompt, the recipient also needs their own connected computer and configured AI tool.

Handoff transfers control of the conversation. It does not migrate a running process, transfer provider credentials, or copy unsynced local files. Keep the current computer online until its turn finishes and saved work uploads.` },
      { id: "offer", title: "Offer the chat", body: `1. While driving the chat, select **Handoff** in the file-manager action area.
2. Review the conversation briefing. Update it if needed, then optionally select **Use briefing in handoff note**.
3. Choose a specific eligible teammate or **Any room editor**.
4. Add a short note about the next action or remaining checks.
5. Select **Offer handoff**.

An offer expires after **one hour**. You can cancel a pending offer. A specifically invited recipient can decline it.`, screenshot: "handoff" },
      { id: "accept", title: "Accept and continue", body: `The recipient opens the chat and selects **Accept control**. Acceptance stays disabled while the current turn is running. Once accepted, the UI shows the new driver.

Accepting does not run a task or spend AI usage. Read the briefing, inspect the transcript and saved changes, and check uploaded checkpoints before sending the next prompt from your own computer.

Recent handoffs remain visible in the dialog. If you want a separate conversation instead, [fork the chat](/docs/ai-conversations#fork).` },
      { id: "offline", title: "When the previous driver is unavailable", body: `A room owner can use **Recover unavailable driver / abandoned turn** when recovery is permitted. This changes control of available saved state; it does not retrieve files that never uploaded.

Open [Activity & checkpoints](/docs/history) and distinguish saved work from unconfirmed local progress before continuing. If an action reports a newer control version, refresh and review the current driver rather than repeating an old action blindly.` },
    ],
  },
  {
    slug: "tasks", category: "Work together", title: "Assign & track tasks",
    description: "Ask a teammate to do work from a chat without starting AI or transferring control.",
    sections: [
      { id: "assign", title: "Assign a task from a conversation", body: `Open an existing AI chat and select **Assign Tasks** in the file-manager action area. Type **@**, choose an eligible teammate from the picker, describe the work, and submit the assignment.

For example: “Please check keyboard navigation and report any remaining issues in this conversation.” Keep the request specific enough that the assignee knows what result to return.

You need room edit access to create an assignment. The assignee must have access to the room, but can be a viewer. If no teammate is available, invite someone with the appropriate access first.`, screenshot: "tasks" },
      { id: "track", title: "Track and finish work", body: `Assignments appear in **Chat tasks** for their source conversation and in the assignee’s workspace **My tasks**. Open the source link to see the relevant room and chat.

Use the status picker to move between **To do**, **In progress**, **Done**, and **Cancelled**. The assignee, or an authorised creator, can update status. Completed tasks remain available rather than disappearing immediately.

If submission fails, correct the reported issue and retry from the preserved draft. Losing room access can make that room’s tasks unavailable.` },
      { id: "different-actions", title: "Task, review, or handoff?", body: `- **Task:** records a human assignment. It does not run AI or change the chat driver.
- **Teammate review:** asks an editor for an outcome against a particular saved version.
- **Handoff:** transfers control of the AI conversation between turns.

Choose the action that matches the result you need. Marking a task Done is not a code approval or a publish action.` },
    ],
  },
  {
    slug: "reviews", category: "Work together", title: "AI review & teammate approval",
    description: "Request AI feedback or record a teammate’s decision against an exact saved version.",
    sections: [
      { id: "ai-review", title: "Ask AI to review", body: `Select **Ask AI to review** in the file-manager actions. It inserts a review request into your composer. Read or edit the prompt, choose the intended model, and send it when ready.

This action requires the same computer/provider readiness as any AI prompt. It does not notify a human reviewer or record approval. Inspect the AI’s findings and verify them against the files.` },
      { id: "request", title: "Request a teammate review", body: `Open **Teammate review** from the chat controls.

1. Confirm the displayed saved version.
2. Choose another eligible editor as reviewer.
3. Explain the requirements, risks, or files to inspect.
4. Select **Request teammate review**.

The request appears in that person’s workspace **Collaboration inbox**. If no reviewer is available, invite another editor or explicitly grant an accepted guest editing access.`, screenshot: "reviews" },
      { id: "respond", title: "Approve or request changes", body: `The assigned reviewer opens the source chat, inspects the saved changes, and enters findings in the review panel. They can **Approve** the displayed version or **Request changes** with a note.

Approval applies only to the requested saved commit. If the repository changes, the older review is labeled as an earlier version and does not approve the new work. Request a new review after those changes.

Reviews preserve their history. The requester can cancel a pending request. Neither approval nor a request for changes starts AI or publishes code.` },
    ],
  },
  {
    slug: "feedback", category: "Work together", title: "Feedback & collaboration inbox",
    description: "Find guest replies, answer directly from a chat, and follow review or access requests.",
    sections: [
      { id: "reply", title: "Respond from the chat", body: `Open **Feedback** in an AI conversation to read guest comments and reply. The feedback count helps you see unread discussion without reopening the share dialog. Load older comments when you need more history.

Write your response and send it. If sending fails, the draft remains so you can retry. Reading displayed comments updates your own unread state; it does not mark everyone else’s inbox as read.`, screenshot: "feedback" },
      { id: "inbox", title: "Use the workspace inbox", body: `The workspace’s **Collaboration inbox** brings together conversations with unread feedback, teammate review requests, and access requests you can handle. Select an item to open the relevant conversation and panel.

Admins may see metadata for an access request without gaining access to the private conversation itself. Review the permission preview before approving a guest’s additional access.

**Shared with me** serves a different purpose: it lists guest conversations you have been invited to view or comment on.` },
    ],
  },
  {
    slug: "connections", category: "Work together", title: "Slack & Discord connections",
    description: "Share selected public channels with a project as attributed context for AI.",
    sections: [
      { id: "requirements", title: "Before connecting a service", body: `You need project management permission. For Slack you also need authority to install the app in the workspace. For Discord you can choose any server your account is in; if the bot isn't there yet, someone who manages that server adds it. The platform administrator must also have configured that provider. If a button says server setup is needed, ask your administrator to enable it.

Selected channels are shared with the entire project. Slack/Discord membership is not copied onto each app user, so check that you are authorised to share those channel discussions with your project. Connecting a service alone imports no channels.`, screenshot: "connections" },
      { id: "slack", title: "Connect Slack", body: `1. Open **Connections** in the workspace and select the intended project.
2. Select **Connect Slack** and complete Slack authorisation.
3. In Slack, invite the installed app to the public channels you want to share.
4. Back in Connections, select **Choose channels** and search or select eligible channels.
5. Confirm that the selected channels can be shared with this project, then save.

Only supported public, unarchived channels containing the app are available. Private channels and DMs are not imported.` },
      { id: "discord", title: "Connect Discord", body: `Choose **Connect Discord** and sign in with Discord. You then see **every server your account is in**, whether or not you created it:

- **Connect**: the bot is already in the server (someone added it before), so any member can connect it.
- **Add bot & connect**: you manage the server, so you can add the bot yourself. Discord opens with that server already chosen.
- **Invite an admin**: you are a member but can't add bots there. Copy the invite link and send it to someone who manages the server. When they add the bot, the server connects to your project. The link works for 7 days.

Then choose and save eligible public text channels. The bot only reads channels everyone in the server can read, so it never shows you anything your Discord account couldn't already see. It needs permission to view channels and read message history; server setup must include the required message-content capability.

Private channels, DMs, voice, forum, and thread channels are excluded in this integration. Check the connection’s status and error message if the expected channel is missing.` },
      { id: "desktop", title: "Complete authorisation from desktop", body: `The desktop app opens the web workspace to complete provider authorisation. Sign in there with the same Multicode AI account, confirm the selected organisation/project, and click **Connect Slack/Discord** in that browser.

After authorising and choosing channels, return to desktop and use **Refresh status**. This keeps the external provider login in the browser while preserving the intended project.` },
      { id: "context", title: "Understand sync and disconnect", body: `The integration makes bounded, attributed channel history available as project context. It is not a complete Slack or Discord archive. Initial sync reads recent messages; supported live events and reconciliation update that context afterward. Look at channel status, sync time, and source links when checking a result.

You can share up to **10 public channels per connection selection**. A project manager can change the selected channels or disconnect the service. Removing a channel stops its future recall and removes its imported source records; it does not delete messages from Slack/Discord or erase excerpts already present in AI transcripts.` },
    ],
  },
  {
    slug: "desktop-settings", category: "Manage & troubleshoot", title: "Desktop settings & local files",
    description: "Pause execution, find your worktrees, change their location, and update the desktop client.",
    sections: [
      { id: "settings", title: "Open desktop settings", body: `Open **Multicode AI → Desktop settings**, or press **Cmd/Ctrl + ,**. This screen controls the workspace address, runner connection, local worktree location, and update checks.

Use **Reopen workspace** to retry the configured server. Changing the workspace address changes which server the desktop client connects to; use the HTTPS origin your team trusts.`, screenshot: "desktop-setup" },
      { id: "pause", title: "Pause, resume, and quit", body: `**Pause after current task** stops new execution and waits for already accepted work to drain. A manual pause persists across relaunches. Use **Resume runner** when ready to accept tasks again.

Signing out stops new work for that account. Quitting normally waits for an active task and its completion report. Force-quitting, shutting down, or letting the computer sleep can interrupt work. Use [Handoff](/docs/handoff) when another person should continue, and inspect uploaded history after an interruption.` },
      { id: "worktrees", title: "Find your local files", body: `Under **Local worktrees**, select **Open folder** to inspect the workspace directory. The default is \`~/multicode-ai/workspaces\`. Each repository in a room has a persistent worktree, created on first use. Chats in that room repository share it.

Use **Change location** while the runner is paused to choose where new worktrees are created. Existing worktrees retain their saved paths; changing the setting is not a migration of all old files.

These managed worktrees are separate from the folder you originally imported. Do not delete a worktree containing unsynced work you still need.`, screenshot: "desktop-worktrees" },
      { id: "updates", title: "Keep desktop and runner current", body: `Use **Check for updates** when your build has an update feed. You approve downloading and restarting to install. Pause the runner and save unsent drafts first.

If the app reports that updates are not configured, use the latest available official installer. An **Update required** computer status means the server needs a newer runner capability; reopening an old build alone will not add it.` },
    ],
  },
  {
    slug: "administration", category: "Manage & troubleshoot", title: "Organisation administration",
    description: "Manage team identity, member access, projects, and the usage information visible to admins.",
    sections: [
      { id: "identity", title: "Manage the team’s identity", body: `Use **Organisation settings** beside the organisation name to change its display information, including the available name/image fields. These controls require management permission.

The organisation rail lets you switch between teams, create an organisation, or view invitations to join another. Keep similarly named teams distinct so members select the intended project and integration scope.` },
      { id: "roles", title: "Manage membership and project access", body: `Open **Organisation admin** to inspect members and the management controls allowed by your role. Admins can manage ordinary membership; ownership and self-management restrictions remain enforced. Suspending an account’s organisation membership is different from deleting its identity.

Use each project’s **Members** dialog to add existing organisation members as viewer, editor, or manager. Use room settings for private-room access. See [members and permissions](/docs/members) before granting wider access.`, screenshot: "project-members" },
      { id: "usage", title: "Read usage and capacity", body: `The admin view shows **Running now** and **AI turns this month**, alongside configured limits where present. These are application execution counters; they are not your AI provider’s token bill or account balance.

AI tasks on members’ own computers are not limited in how many run at once: each uses that person’s machine and AI account. A limit on tasks at once applies only when they run on the application’s server, and only if the administrator has set one.

If a limit blocks new work, let active work finish or ask the administrator about the configured allowance. Repeatedly sending the same prompt will not bypass a concurrency or usage limit. AI providers can impose their own additional limits.` },
      { id: "hosting", title: "Operating a private deployment", body: `End users do not need to install PostgreSQL, Redis, Docker, or the application source. Those belong to server administration.

If you are hosting the platform yourself, start with the repository’s [production deployment guide](https://github.com/Prathamesh314/multiplayer-ai/blob/main/docs/production-deployment.md). It covers the server stack, HTTPS/domain setup, environment configuration, migrations, health checks, and deployment. Access to that repository may be required. Use its [backup and restore guide](https://github.com/Prathamesh314/multiplayer-ai/blob/main/docs/backup-restore.md) for recovery.

Invitation generation requires a valid public website origin. Clerk handles authentication and email verification; Slack and Discord require separate integration configuration. Do not put server secrets or OAuth credentials into shared chat. These user guides do not replace the deployment runbook.` },
    ],
  },
  {
    slug: "troubleshooting", category: "Manage & troubleshoot", title: "Troubleshooting",
    description: "Find the cause of connection, invitation, model, file, and collaboration errors.",
    sections: [
      { id: "cannot-send", title: "I can open a chat but cannot send", body: `Read the message above the composer, then check in order:

1. **Access:** you need editing access, not only a guest/viewer invitation.
2. **Control:** another teammate may be driving this chat. Accept a handoff or fork your own conversation.
3. **Computer:** open **Your computers** and bring your own device online.
4. **AI setup:** open **Providers**, check installation/login, and refresh connections.
5. **Selection:** choose an available model and supported effort.
6. **Active work:** if the agent is already running, use Queue message or wait for completion.

Starting without files still requires computer and AI setup to send a prompt.` },
      { id: "offline", title: "My computer is offline or not detected", body: `Wake the computer, restore internet access, and open desktop using the same account as the browser. Check whether the runner was paused. For the standalone runner, leave the start command running in a terminal.

Use **Check connection again**. If the app asks for an update, install the newer desktop/runner. If the device was revoked, pair it again explicitly. Repeated disconnects can indicate a proxy/firewall blocking the workspace’s streaming connections.` },
      { id: "invites", title: "An invitation link does not work", body: `- **Wrong hostname:** a public invitation must use your workspace’s public domain, not \`0.0.0.0\` or someone else’s \`localhost\`. For this service use \`https://multicode.in\` and preserve the rest of the link.
- **Expired/replaced link:** ask the host for a fresh invitation. Organisation links expire after 14 days; guest chat access lasts 7 days from creation; handoff offers last one hour.
- **Wrong email:** guest links are bound to the invited email. Sign in with that account.
- **Incomplete URL:** preserve the entire guest link, including its \`#invite=\` fragment.
- **Already accepted:** open the workspace or Shared with me; an organisation invitation is single-use.
- **Team joined, project missing:** ask the project manager to add you to the project.

Do not post the complete token in a public support thread.` },
      { id: "email", title: "The verification email hasn’t arrived", body: `Check the entered address and spam folder. Wait for the resend timer, then request a new code and use the newest email. Follow the code expiry and resend instructions shown by Clerk.

If the page reports delivery failure, follow its retry guidance or contact the workspace administrator. Email delivery acceptance does not guarantee placement in the inbox. Google sign-in does not require this separate code flow.` },
      { id: "provider", title: "A model is missing or the provider fails", body: `Try the installed AI CLI directly on the connected computer and finish its own login or provider configuration. Update the CLI if needed, then use **Check connections** and refresh the model picker.

If the app marks a model unavailable, select an available model explicitly. If the provider reports quota or billing errors, resolve them in that provider’s account. For local models, confirm the model is installed and the expected local server is running. Discovery does not download weights.` },
      { id: "files", title: "Files or changes are missing", body: `Confirm the selected room and repository. Your original imported folder, the app’s saved repository, and the runner’s managed worktree are separate locations. Check import completion, save status, the last uploaded activity, and whether the correct repository was published or synced.

Inspect **Activity & checkpoints** after an interrupted task. Unsynced local files are not available to teammates yet. If editing or publication conflicts, preserve your work and resolve the conflict before retrying.` },
      { id: "integrations-terminal", title: "A connection or terminal is unavailable", body: `For Slack/Discord, confirm the intended project, your management permission, server-side provider setup, and the bot’s channel access. Select supported public channels and save the sharing consent. Use **Refresh status** after authorising in the browser.

For the terminal, see [terminal availability](/docs/terminal). Connecting an AI computer does not enable a remote shell in the hosted application.` },
      { id: "report", title: "Give your administrator a useful report", body: `Include the action you tried, exact visible error, approximate time, desktop/browser version, and whether the computer/provider showed as connected. Share a screenshot with private conversation text and credentials removed.

Describe what happened before retrying an unconfirmed instruction or recovery action. Do not include invitation tokens, provider credentials, verification codes, or the runner’s private configuration file.` },
    ],
  },
);

export function findGuide(slug: string) { return guides.find(guide => guide.slug === slug); }
