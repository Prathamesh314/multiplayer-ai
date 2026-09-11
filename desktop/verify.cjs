const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

module.exports = async function verify(context) {
  const { listPackage, extractFile } = await import("@electron/asar");
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app", "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  const expected = ["main.js", "runner.cjs", "preload.js", "setup-preload.js", "setup.html", "setup.css", "setup.js", "icon.png", "release.json", "package.json", "THIRD-PARTY-NOTICES.txt"];
  const actual = listPackage(archive).map(file => file.replace(/^[\\/]/, ""));
  if (actual.length !== expected.length || actual.some(file => !expected.includes(file))) throw new Error("Desktop archive contains unexpected files: " + actual.filter(file => !expected.includes(file)).slice(0, 20).join(", "));
  const manifest = JSON.parse(extractFile(archive, "package.json").toString());
  if (Object.keys(manifest.dependencies || {}).length) throw new Error("Desktop package must not depend on the backend's node_modules.");
  if (!fs.existsSync(path.join(resources, "app.asar.unpacked", "runner.cjs"))) throw new Error("Bundled runner is missing.");
  if (context.electronPlatformName === "darwin") {
    execFileSync("/usr/bin/xattr", ["-cr", path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app")]);
  }
  console.log("Verified desktop archive allowlist: no backend, .env, credentials, or source checkout.");
};
