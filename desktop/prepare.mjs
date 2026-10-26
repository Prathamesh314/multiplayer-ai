import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { workspaceUrl } = require("./policy.js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".desktop-build", "app");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = process.env.DESKTOP_RELEASE === "1";
// Installers open multicode.in unless built for another server. Only `--setup`
// test builds (here, or DESKTOP_WORKSPACE_URL="" from package.mjs) ask for an address.
const configured = process.argv.includes("--setup") ? "" : process.env.DESKTOP_WORKSPACE_URL ?? "https://multicode.in";
const origin = configured ? workspaceUrl(configured, !release) : "";
let updateUrl = "";
if (process.env.DESKTOP_UPDATE_URL) {
  const parsed = new URL(process.env.DESKTOP_UPDATE_URL);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("DESKTOP_UPDATE_URL must be a public HTTPS feed URL without credentials or query parameters.");
  updateUrl = parsed.href;
}
if (release && (!origin || !updateUrl)) throw new Error("Release builds require DESKTOP_WORKSPACE_URL and DESKTOP_UPDATE_URL.");

await mkdir(target, { recursive: true });
const options = { bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true, sourcemap: false, legalComments: "eof" };
const main = await build({ ...options, entryPoints: [join(root, "desktop", "main.js")], outfile: join(target, "main.js"), external: ["electron", "next/dist/bin/next"] });
const runner = await build({ ...options, entryPoints: [join(root, "runner", "index.ts")], outfile: join(target, "runner.cjs") });
// icon.png is built from the brand mark by scripts/brand-icons.mjs.
for (const file of ["preload.js", "setup-preload.js", "setup.html", "setup.css", "setup.js", "icon.png"]) await copyFile(join(root, "desktop", file), join(target, file));
// The release this build becomes (its folder name on the website, e.g.
// preview-<commit>-<run>), so the app can tell when the website has a newer one.
const releaseId = /^[A-Za-z0-9._-]{1,100}$/.test(process.env.DESKTOP_BUILD_ID ?? "") ? process.env.DESKTOP_BUILD_ID : "";
const commit = /^[0-9a-f]{7,40}$/.test(process.env.DESKTOP_COMMIT ?? "") ? process.env.DESKTOP_COMMIT : "";
const sourceUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(process.env.DESKTOP_SOURCE_URL ?? "") ? process.env.DESKTOP_SOURCE_URL : "";
await writeFile(join(target, "release.json"), JSON.stringify({ workspaceUrl: origin, updateUrl, build: releaseId, commit, sourceUrl }, null, 2));
await writeFile(join(target, "package.json"), JSON.stringify({ name: "multicode-ai-desktop", productName: "Multicode AI", version: manifest.version, description: "A shared workspace for your team's AI work", author: "Multicode AI", private: true, main: "main.js", dependencies: {} }, null, 2));

const notices = [];
const packages = new Set();
for (const input of new Set([...Object.keys(main.metafile.inputs), ...Object.keys(runner.metafile.inputs)])) {
  if (!input.includes("node_modules/")) continue;
  let folder = dirname(resolve(root, input));
  while (folder !== root && folder !== dirname(folder)) {
    try {
      const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
      if (!packages.has(folder)) {
        packages.add(folder);
        const licenses = (await readdir(folder)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
        notices.push(pkg.name + " " + pkg.version + "\nDeclared license: " + JSON.stringify(pkg.license) + "\nAuthor: " + JSON.stringify(pkg.author) + "\nSource: " + JSON.stringify(pkg.repository) + "\n" + (licenses.length ? (await Promise.all(licenses.map(name => readFile(join(folder, name), "utf8")))).join("\n") : "No separate license file supplied in the installed package."));
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      folder = dirname(folder);
    }
  }
}
await writeFile(join(target, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n-----\n\n"));
await writeFile(join(root, ".desktop-build", "bundle-inputs.json"), JSON.stringify({ main: Object.keys(main.metafile.inputs), runner: Object.keys(runner.metafile.inputs) }, null, 2));
console.log("Prepared desktop client and bundled runner in " + target);
