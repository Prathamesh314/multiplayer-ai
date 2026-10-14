# Standalone runner distribution

Desktop installations already bundle a runner and connect it after sign-in.
Browser users download a standalone npm package from their workspace origin.
Neither route needs access to this repository or the server's source code.

`npm run runner:pack` bundles `runner/index.ts` into one Node.js executable with
esbuild, then uses `npm pack` to create
`public/downloads/multicode-ai-runner.tgz`. Only the executable, package
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
changes. Existing global installations still work and can be reinstalled to upgrade.

Node.js 22+ and npm/npx are required for this standalone option. The connection
dialog uses `npx --yes --package="<workspace>/downloads/multicode-ai-runner.tgz"
multicode-ai-runner` for both pairing and starting. npm downloads the package
into its user cache and supplies the executable's PATH for that invocation.
This avoids global installation permissions and missing global-bin PATH entries.
Keep the explicit package URL: this package is not published on the npm registry.
The CLI
supports `pair`, `start`, `workspaces`, `--help`, and `--version` from any working
directory. Desktop users do not need Node.js/npm installed separately.

Run `npm run test:runner-package` to serve the real archive from a temporary HTTP
server and exercise both an isolated global installation and the npx flow with
registry access disabled. The npx case starts with an empty cache and no global
runner on PATH. Both invoke it from two empty directories, including paths with
spaces. The test verifies pairing/configuration, heartbeat, push events and revoked-token exit
using a mock workspace. It never pairs with or changes the real application.
The PostgreSQL/Chrome suite separately checks the connection dialog and the
production server's downloadable archive.

Reference: [npm exec and npx package execution](https://docs.npmjs.com/cli/v11/commands/npm-exec/).
