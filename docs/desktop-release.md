# Desktop release

## Scope and release gates

The distributable is a hosted/self-hosted workspace client with a bundled local
runner. It does not embed PostgreSQL, Redis, or the Next.js server. Development
can still start a local Next.js server. End users should not need this repository
or npm to start the desktop app; Git and their chosen agent CLI remain external
prerequisites for local execution.

Implementation phases:

1. Restrict navigation, permissions, external URLs, and privileged IPC. Add a
   single-instance lock and an actionable local connection/recovery screen.
2. Bundle the runner with Electron's Node runtime, connect after sign-in,
   persistent pause controls, and graceful shutdown.
3. Stage only explicitly allowed desktop assets, configure installers and
   opt-in signed updates, and fail closed on missing release configuration.
4. Run policy, packaging, and real Electron smoke tests; record results and
   unresolved signing/platform/backend gates below.

A successful unsigned local build is not a shipping approval. Signing,
notarization, a deployed production workspace, an update feed, and real-platform
acceptance are mandatory external release inputs. Backend risks in
`production-readiness-plan.md` still apply; an Electron wrapper does not fix them.

## Implemented

- Isolated, sandboxed web renderer with no Node integration or generic IPC.
  Exact-origin navigation restrictions, denied popups/webviews/downloads and
  permissions, and native confirmation before opening HTTP(S)/mailto links.
- A separate local setup window with a restrictive CSP and a separate preload.
  Only its main frame can change settings. The remote workspace can only request
  native pairing, from its main frame and the configured origin.
- HTTPS-only workspace origins in packaged builds. Development additionally
  permits loopback HTTP. Credentials, paths, query parameters and fragments in
  workspace addresses are rejected. TLS verification is never bypassed.
- First-run connection UI, bounded readiness checks, offline/render-crash
  recovery, single-instance behavior, menu/tray access and persistent sessions.
- Automatic connection after sign-in, a bundled utility-process runner, filtered
  environment, private per-account connection profiles and persistent pause.
  Signing out stops new claims; returning to the same account reuses its saved
  connection. Revoked devices require explicit reconnection through the existing
  native pairing dialog. A pending claim is drained rather than abandoned; quitting waits for the
  current/already-requested task and its completion report. Normal Git/API calls
  have timeouts. Forced OS termination can still interrupt work.
- Explicit asset allowlist, post-package archive verification, bundled dependency
  notices, application icon, DMG/ZIP, NSIS and preview AppImage configuration.
  Backend code, node_modules, .env files and source repositories are not shipped.
- Packaged Electron fuses disable RunAsNode, Node environment injection and Node
  CLI inspection, and enable ASAR-only loading/integrity validation. Preview Macs
  use ad-hoc signing; release Macs require signing, hardened runtime and notarization.
- Update checks against a build-configured HTTPS feed. Downloads require consent;
  installation requires another confirmation, a stopped runner and no pairing in
  progress. No automatic install on quit or downgrade. Platform updater signature
  verification remains enabled.
- Desktop policy tests, real Electron smoke tests and preview CI for macOS,
  Windows and Linux, including Apple Silicon and Intel Macs.
  A separate manual macOS candidate workflow uses a protected release environment
  and never publishes automatically.

## Development and preview builds

Use Node 24 and `npm ci` on the target platform.

```sh
npm start                       # local development, backend services required
npm run desktop:attach          # connection settings, no server spawned
npm run desktop:prepare         # bundle client and runner only
npm run test:desktop
npm run test:desktop:smoke       # opens isolated test windows; no paid AI requests
npm run desktop:pack            # unpacked application
npm run desktop:dist            # preview installers for this OS/architecture
npm run desktop:dist:mac        # setup-screen DMG + ZIP for this Mac architecture
npm run desktop:dist:win        # setup-screen Windows x64 NSIS .exe
npm run desktop:dist:linux      # setup-screen Linux x64 AppImage
node tests/desktop-smoke.mjs --packaged
```

Preview installers start with **Workspace address**. Enter the HTTPS origin of
your deployed workspace; these installers do not deploy a server. The platform
scripts use `--setup`, which clears any workspace/update URL inherited from the
build environment. Preview filenames include `-preview` and are not published.
The website's placeholder download links remain placeholders until distribution
is ready.

After signing in, the desktop app connects this computer automatically; users
do not need a pairing command. Install Git and install/authenticate the chosen AI
CLI first. The desktop menu can pause or resume execution; a manual pause survives
relaunches. Signing out stops new work and drains any already claimed task. The
server needs Redis and local runners enabled to dispatch jobs to the desktop.

Build one platform/architecture at a time, for example
`npm run desktop:dist -- --mac --x64 --setup`. Supported architectures are `x64`
and `arm64`; cross-platform builds default to x64. Build macOS on a Mac, and run
signed releases on their native platform. Other cross builds may need additional
system tooling; use the native CI jobs for reproducible results. The packaged
smoke test requires the target OS and architecture.

In GitHub Actions, run **Desktop checks and preview installers** on the desired
branch. Its four jobs build and smoke-test macOS arm64, macOS x64, Windows x64 and
Linux x64, then upload separate `desktop-preview-*` artifacts for 14 days. Linux
tests use Xvfb for a virtual display. Download and extract an artifact to get the
installer and its `SHA256SUMS-*-preview.txt` file. This workflow does not create a
public GitHub Release or upload to an update feed.

On macOS, open the DMG and drag the app to Applications (or extract the ZIP). On
Windows, run the NSIS `.exe` and choose an installation location. On Linux, mark
the AppImage executable with `chmod +x Multiplayer-AI-*.AppImage` and run it;
systems without FUSE can use `./Multiplayer-AI-…AppImage --appimage-extract-and-run`.
Preview Mac builds are ad-hoc signed and Windows builds are unsigned, so normal
OS trust checks may warn or block them. Public distribution still needs the
signing steps below.

`desktop:prod` is an alias for attach mode, not a standalone backend installer.
For a local production server, build the web application and start `next:start`
separately. `APP_URL` overrides the saved workspace only in unpackaged development.
`DESKTOP_RUNNER=0` disables runner startup. `DESKTOP_SPAWN_SERVER=0` disables the
optional development server. Packaged builds ignore `APP_URL` and never spawn npm.

Installers and SHA-256 checksum files are under `desktop-dist/`. Packaging/signing
runs in an OS temporary directory to avoid synced Desktop folders attaching
Finder metadata that invalidates macOS signatures. The unpacked application stays
there; its path is printed and recorded in `.desktop-build/output.json` for smoke
tests. Temporary unpacked builds can be removed after validation. The version comes from root `package.json`;
increment it before each release. Staged bundles and installer output are ignored
by Git. `.desktop-build/bundle-inputs.json` records the bundled source inventory.
Do not publish ad-hoc/unsigned preview builds as production releases.

## Signed macOS release

Set these in a protected CI environment, not a tracked file:

- `DESKTOP_WORKSPACE_URL`: deployed production HTTPS workspace origin.
- `DESKTOP_UPDATE_URL`: public HTTPS directory for updater metadata/installers.
- `CSC_LINK`: Developer ID signing certificate, using electron-builder's supported
  secret-file/base64 mechanism; `CSC_KEY_PASSWORD`: its password. A local signing
  identity can instead be selected with `CSC_NAME`.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization, or
  the supported `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` alternative.

Run `npm run desktop:release`. Missing configuration/credentials fail the build.
In GitHub, configure the `desktop-release` environment with required reviewers,
main-branch restrictions, the two URL variables and the signing/notarization
secrets. Then manually run **Signed desktop release candidate** on main.
This uploads candidate artifacts only; it does not deploy the application or feed.

Verify the resulting application on a clean Mac:

```sh
codesign --verify --deep --strict --verbose=2 'Multiplayer AI.app'
spctl --assess --type execute --verbose=2 'Multiplayer AI.app'
xcrun stapler validate 'Multiplayer AI.app'
```

Publish the generated ZIP/DMG/blockmaps first, then `latest-mac.yml` atomically at
the configured feed. Retain the previous installers. Test a real older-signed to
newer-signed update before widening distribution. Never edit updater checksums or
disable certificate verification to make a release pass.

Windows NSIS packaging is configured; release builds must run on Windows with an
appropriate signing certificate. Validate publisher identity, installation,
uninstallation, .cmd-based agent CLIs and signed updates there before supporting
Windows publicly. Linux AppImage remains a preview, not a signed release target.

## Operational behavior and limitations

The desktop is a networked client, not an offline database or execution sandbox.
The configured server is explicitly trusted to dispatch the user's jobs. Pairing
is not protection against a compromised trusted server or malicious agent
commands. Backend authorization, execution isolation and recovery gates from the
production plan remain prerequisites for a public service.

Desktop settings and the private `runner.json` live under Electron's userData
directory (macOS: `~/Library/Application Support/Multiplayer AI`). Saved connection
profiles live in `connections`; each new account/server combination has a separate
`runner-data/<profile hash>` directory for its outbox and repository cache. User
worktrees use the configured workspace directory. Runner tokens are mode-0600 files on POSIX,
not Keychain-encrypted; Windows relies on the user's profile ACLs. The desktop does
not silently reuse the CLI's older `~/.config/multiplayer-ai/runner.json` identity.
Revoke unused devices in **Your computers**. Uninstall preserves user data.

CLI tools must be installed, authenticated and discoverable on PATH. Common
Homebrew and user-local bin directories are added on macOS/Linux, but custom
Node-version-manager installations may still need PATH setup. No AI tools are
silently installed, authenticated or purchased. Runner errors are shown without
logging provider output/tokens to desktop logs.

Downloads and browser permission requests are denied intentionally. Existing
folder uploads still use the normal file picker; adding native export, camera,
microphone or notification features requires a scoped permission design.

## Shipment checklist

- [ ] Production workspace deployed, backend security/durability gates passed.
- [ ] Product identity, support contact, privacy policy, terms and third-party
      notices reviewed (some dependencies provide license metadata but no file).
- [ ] Signing/notarization credentials and protected release environment configured.
- [ ] Clean-machine install, login, folder import, local pairing, real model task,
      handoff, pause/resume, network outage and quit verified on every supported OS.
- [ ] Upgrade from a previous signed version verified against the actual feed;
      tampered download/signature rejection and interrupted download tested.
- [ ] Sleep/wake, reboot, missing Git/CLI, revoked device, expired login and
      renderer-crash recovery accepted; support/rollback owner assigned.
- [ ] Publish installers/metadata only after the signed candidate is approved.

## Validation record — September 11, 2026

- Web regression suite: 173 checks passed, including model discovery and knowledge.
- Production webpack web build and TypeScript check passed after security patch
  updates to Next.js 16.3.4 and associated image/YAML dependencies. npm reported
  zero known dependency vulnerabilities after those updates; this is not a
  security certification.
- Existing real-PostgreSQL/browser integration passed: imports, shared file/chat
  tabs, model picker, native browser folder upload, handoff and two real Git-backed
  runner turns. Agent outputs in these tests are deterministic fixtures, not paid
  inference.
- Nine desktop policy tests passed, covering origin/protocol restrictions, readiness timeouts,
  IPC sender validation, native consent, private token storage and runner pause.
- Real development Electron smoke passed: setup, sandboxed preload, connection,
  navigation/popup restrictions and offline recovery. The bundled runner started,
  heartbeated and drained in an Electron utility process without npm or agent tools.
- The first packaging attempt exposed unwanted root dependencies; explicit
  exclusions plus archive allowlist verification fixed it. The first macOS launch
  exposed invalid unsigned signatures; preview ad-hoc signing and packaging outside
  the synced Desktop directory address that environment-specific failure.
- macOS Apple Silicon DMG and ZIP preview artifacts built. The actual packaged
  application launched with an isolated profile, rendered its sandboxed setup UI,
  and rejected insecure remote and loopback HTTP workspace origins. Archive
  contents passed the strict desktop-only allowlist. This preview is ad-hoc signed,
  not Developer ID signed or notarized for public distribution.
- Final installer SHA-256 checksums, macOS deep/strict signature-structure
  verification and DMG integrity verification passed. These checks do not establish
  Developer ID identity, notarization or Gatekeeper acceptance on another machine.
- No signing identity/notarization credentials, production workspace address or
  update feed were supplied. The signed release command correctly refuses to
  proceed without credentials. No public installer or update has been published.
- Windows/Linux execution, clean-machine signed installation, live native pairing
  against the production service, real-model inference and signed upgrades remain
  unverified shipment gates. CI workflows are checked in, not executed remotely.

## Validation record — September 29, 2026

- [Native preview workflow](https://github.com/Prathamesh314/multiplayer-ai/actions/runs/36580459520)
  passed on macOS 15 arm64, macOS 15 Intel, Windows 2025 x64, and Ubuntu 22.04 x64
  at commit `2715c54`. Each job passed all 11 policy/packaging tests, the development
  Electron/runner smoke test, archive allowlist verification and the packaged
  setup-screen launch test before uploading installers and SHA-256 checksums.
- Produced macOS DMG/ZIP for both architectures, Windows NSIS `.exe`, and Linux
  AppImage. All previews use the setup screen with no embedded workspace or update
  URL. Build commands never publish artifacts automatically.
- Local Apple Silicon DMG/ZIP packaging, development/packaged smoke tests,
  deep/strict ad-hoc signature verification, DMG integrity and checksum checks
  also passed. Intel Mac DMG/ZIP cross packaging succeeded locally.
- Fixed a Windows test cleanup race: Electron helpers briefly retained cookie
  database handles after shutdown; bounded filesystem retries now allow cleanup.
- These checks launch the packaged executables; they do not establish clean-user
  installer/uninstaller acceptance, production login/pairing, or signed upgrades.
  Developer ID/notarization and Windows publisher signing remain unconfigured.

## References

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process)
- [electron-builder updates](https://www.electron.build/v26/docs/features/auto-update/)
- [electron-builder platform builds](https://www.electron.build/v26/docs/features/multi-platform-build/)
- [Electron headless testing](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)
- [electron-builder signing](https://www.electron.build/docs/features/code-signing/)
