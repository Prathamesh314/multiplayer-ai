# Standalone runner distribution

Desktop installations already bundle a runner and connect it after sign-in.
Browser users download a standalone npm package from their workspace origin.
Neither route needs access to this repository or the server's source code.

`npm run runner:pack` bundles `runner/index.ts` into one Node.js executable with
esbuild, then uses `npm pack` to create
`public/downloads/multiplayer-ai-runner.tgz`. Only the executable, package
manifest, and user README are shipped. The builder fails if a new import pulls
third-party packages into the bundle, requiring an explicit license/dependency
review before distribution. Credentials, environment files, server database
code and source maps are not packaged. No install scripts or runtime npm
dependencies are needed.

The `predev` and `prebuild` hooks generate the package before the workspace
starts or builds. Deploy `public/` along with the Next.js build, as with other
static assets. Custom deployment commands that bypass npm lifecycle hooks must
run `npm run runner:pack` explicitly. The workspace serves the archive directly;
no npm registry publication is required. Regenerate it whenever runner code
changes and reinstall to upgrade an existing standalone installation.

Node.js 22+ and npm are required for this standalone option. npm creates the
global `multiplayer-ai-runner` command; its prefix must be on PATH. The CLI
supports `pair`, `start`, `workspaces`, `--help`, and `--version` from any working
directory. Desktop users do not need Node.js/npm installed separately.

Run `npm run test:runner-package` to serve the real archive from a temporary HTTP
server, install it in an isolated global prefix with registry access disabled,
and invoke it from two empty directories, including paths with spaces. The test
verifies pairing/configuration, heartbeat, job polling and revoked-token exit
using a mock workspace. It never pairs with or changes the real application.
The PostgreSQL/Chrome suite separately checks the connection dialog and the
production server's downloadable archive.

Reference: [npm installation from tarball URLs and global binaries](https://docs.npmjs.com/cli/v11/commands/npm-install/).
