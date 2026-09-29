const { join } = require("node:path");

function buildTarget(args, host = process.platform, hostArch = process.arch) {
  const platforms = { "--mac": "darwin", "--win": "win32", "--linux": "linux" };
  const allowed = [...Object.keys(platforms), "--x64", "--arm64", "--dir", "--release", "--setup"];
  for (const arg of args) if (!allowed.includes(arg)) throw new Error("Unsupported desktop build option: " + arg);
  const selected = args.filter(arg => platforms[arg]);
  const architectures = args.filter(arg => ["--x64", "--arm64"].includes(arg));
  if (selected.length > 1 || architectures.length > 1) throw new Error("Build one platform and architecture per invocation.");
  const platform = selected.length ? platforms[selected[0]] : host;
  const arch = architectures.length ? architectures[0].slice(2) : platform === host ? hostArch : "x64";
  if (!Object.values(platforms).includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Unsupported desktop platform or architecture.");
  if (platform === "darwin" && host !== "darwin") throw new Error("Build macOS installers on a Mac.");
  const release = args.includes("--release");
  if (release && platform !== host) throw new Error("Signed releases must be built on their target platform.");
  if (release && args.includes("--setup")) throw new Error("Setup-only builds are previews; releases require workspace and update URLs.");
  return { platform, arch, release, setup: args.includes("--setup"), builderArgs: [Object.keys(platforms).find(key => platforms[key] === platform), "--" + arch, ...(args.includes("--dir") ? ["--dir"] : [])] };
}

function packagedExecutable(directory, platform, arch) {
  if (platform === "darwin") return join(directory, "mac" + (arch === "x64" ? "" : "-" + arch), "Multiplayer AI.app", "Contents", "MacOS", "Multiplayer AI");
  if (platform === "win32") return join(directory, "win" + (arch === "x64" ? "" : "-" + arch) + "-unpacked", "Multiplayer AI.exe");
  if (platform === "linux") return join(directory, "linux" + (arch === "x64" ? "" : "-" + arch) + "-unpacked", "multiplayer-ai");
  throw new Error("Unsupported desktop platform: " + platform);
}

module.exports = { buildTarget, packagedExecutable };
