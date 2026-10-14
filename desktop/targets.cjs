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

/**
 * Gatekeeper refuses to start a quarantined ad-hoc bundle: dyld stalls before it maps a
 * single library, so a downloaded preview never reaches its first line of JavaScript.
 * Ad-hoc is therefore a last resort for builds that have no certificate at all, not the
 * default for every preview. Hardened runtime is required for notarization.
 */
function macSigning(env = process.env, release = false) {
  const certificate = env.CSC_NAME !== "-" && Boolean(env.CSC_LINK || env.CSC_NAME);
  const notarize = Boolean((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));
  if (release) return { hardenedRuntime: true, notarize: true };
  if (!certificate) return { hardenedRuntime: false, notarize: false, identity: "-" };
  return { hardenedRuntime: true, notarize };
}

function packagedExecutable(directory, platform, arch) {
  if (platform === "darwin") return join(directory, "mac" + (arch === "x64" ? "" : "-" + arch), "Multicode AI.app", "Contents", "MacOS", "Multicode AI");
  if (platform === "win32") return join(directory, "win" + (arch === "x64" ? "" : "-" + arch) + "-unpacked", "Multicode AI.exe");
  if (platform === "linux") return join(directory, "linux" + (arch === "x64" ? "" : "-" + arch) + "-unpacked", "multicode-ai");
  throw new Error("Unsupported desktop platform: " + platform);
}

module.exports = { buildTarget, macSigning, packagedExecutable };
