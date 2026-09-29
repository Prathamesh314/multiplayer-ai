import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const { buildTarget, packagedExecutable } = require("./targets.cjs");
const { platform, arch, release, setup, builderArgs } = buildTarget(process.argv.slice(2));
const env = { ...process.env, DESKTOP_RELEASE: release ? "1" : "0" };
if (setup) {
  env.DESKTOP_WORKSPACE_URL = "";
  env.DESKTOP_UPDATE_URL = "";
}
if (release) {
  if (!["darwin", "win32"].includes(process.platform)) throw new Error("Signed release builds are supported only on macOS and Windows. Linux builds are previews until platform acceptance is complete.");
  if (!env.CSC_LINK && !env.CSC_NAME) throw new Error("Provide CSC_LINK or CSC_NAME for a signed release.");
  if (env.CSC_NAME === "-") throw new Error("Ad-hoc signing cannot be used for a release.");
  if (process.platform === "darwin" && !(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) && !(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)) throw new Error("Apple notarization credentials are required for a macOS release.");
}
env.DESKTOP_OUTPUT_DIR = await mkdtemp(join(tmpdir(), "multiplayer-desktop-build-"));
for (const args of [["desktop/prepare.mjs"], [require.resolve("electron-builder/cli.js"), "--config", "desktop/builder.cjs", ...builderArgs, "--publish", "never"]]) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir("desktop-dist", { recursive: true });
const hashes = [];
for (const file of (await readdir(env.DESKTOP_OUTPUT_DIR)).sort()) {
  if (!/\.(dmg|zip|exe|AppImage|blockmap)$/.test(file) && !/^latest.*\.yml$/.test(file)) continue;
  await copyFile(join(env.DESKTOP_OUTPUT_DIR, file), join("desktop-dist", file));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(env.DESKTOP_OUTPUT_DIR, file))) hash.update(chunk);
  hashes.push(hash.digest("hex") + "  " + file);
}
if (hashes.length) await writeFile(join("desktop-dist", "SHA256SUMS-" + platform + "-" + arch + (release ? "" : "-preview") + ".txt"), hashes.join("\n") + "\n");
await writeFile(".desktop-build/output.json", JSON.stringify({ directory: env.DESKTOP_OUTPUT_DIR, executable: packagedExecutable(env.DESKTOP_OUTPUT_DIR, platform, arch), platform, arch, release }, null, 2));
console.log("Unpacked application: " + env.DESKTOP_OUTPUT_DIR);
console.log("Installers: " + resolve("desktop-dist"));
