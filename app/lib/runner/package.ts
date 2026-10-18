/*
 * The standalone runner's package, served by this workspace. Its address
 * carries the package's fingerprint (next.config.ts): npx caches a package by
 * its address, so a new runner gets a new address and is fetched fresh.
 */
export function runnerPackageUrl(origin: string) {
  const version = process.env.NEXT_PUBLIC_RUNNER_PACKAGE;
  return `${origin}/downloads/multicode-ai-runner.tgz${version ? `?v=${version}` : ""}`;
}

/** `npx … multicode-ai-runner <args>`: no global install, always the current package. */
export const runnerCommand = (origin: string, args: string) =>
  `npx --yes --package="${runnerPackageUrl(origin)}" multicode-ai-runner ${args}`;
