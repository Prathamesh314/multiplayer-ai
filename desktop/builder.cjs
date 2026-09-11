const path = require("node:path");
const fs = require("node:fs");
const release = process.env.DESKTOP_RELEASE === "1";
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../.desktop-build/app/release.json"), "utf8"));

if (release && (!config.workspaceUrl || !config.updateUrl)) throw new Error("Prepare a configured release build first.");

module.exports = {
  appId: "ai.multiplayer.desktop",
  productName: "Multiplayer AI",
  directories: { app: ".desktop-build/app", output: process.env.DESKTOP_OUTPUT_DIR || "desktop-dist", buildResources: ".desktop-build/app" },
  files: ["main.js", "runner.cjs", "preload.js", "setup-preload.js", "setup.html", "setup.css", "setup.js", "icon.png", "release.json", "package.json", "THIRD-PARTY-NOTICES.txt", "!node_modules/**/*"],
  asar: true,
  asarUnpack: ["runner.cjs"],
  npmRebuild: false,
  afterPack: require("./verify.cjs"),
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  forceCodeSigning: release,
  artifactName: "Multiplayer-AI-\${version}-\${os}-\${arch}.\${ext}",
  publish: config.updateUrl ? [{ provider: "generic", url: config.updateUrl }] : null,
  mac: {
    target: ["dmg", "zip"], category: "public.app-category.developer-tools",
    icon: "icon.png", hardenedRuntime: release, notarize: release,
    ...(release ? {} : { identity: "-" }),
  },
  win: { target: ["nsis"], icon: "icon.png", verifyUpdateCodeSignature: true },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  linux: { target: ["AppImage"], icon: "icon.png", category: "Development" },
};
