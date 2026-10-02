import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Load an ignored local file without running shell code or overriding CI secrets. */
export function localReleaseEnvironment(base = process.env, file = '.env.desktop.local') {
  return { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...base };
}
export function releaseChecks(env, platform = process.platform) {
  const errors = [];
  const https = (name, origin) => {
    try {
      const url = new URL(env[name]);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (origin && url.pathname !== '/') || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error();
    } catch { errors.push(`Set ${name} to ${origin ? 'the deployed public HTTPS workspace origin' : 'the public HTTPS update feed directory'}.`); }
  };
  https('DESKTOP_WORKSPACE_URL', true); https('DESKTOP_UPDATE_URL', false);
  if (!['darwin','win32'].includes(platform)) errors.push('Signed release acceptance currently supports macOS and Windows; Linux remains a preview.');
  if ((!env.CSC_LINK && !env.CSC_NAME) || env.CSC_NAME === '-') errors.push('Configure a valid publisher certificate with CSC_LINK or CSC_NAME; ad-hoc signing is insufficient.');
  if (platform === 'darwin' && !(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) && !(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)) errors.push('Configure Apple notarization credentials locally.');
  return errors;
}
export async function checkWorkspace(env) {
  const response = await fetch(new URL('/health/ready', env.DESKTOP_WORKSPACE_URL), { redirect:'error', signal:AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Production workspace readiness check failed.');
}
export function verifySignedMac(app) {
  for (const [command,args] of [
    ['/usr/bin/codesign',['--verify','--deep','--strict',app]],
    ['/usr/sbin/spctl',['--assess','--type','execute',app]],
    ['/usr/bin/xcrun',['stapler','validate',app]],
  ]) execFileSync(command,args,{stdio:'inherit'});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const env=localReleaseEnvironment(),errors=releaseChecks(env);
  if(errors.length) { console.error(errors.map(error=>'- '+error).join('\n')); process.exitCode=1; }
  else {
    try { await checkWorkspace(env); console.log('Release configuration and deployed workspace readiness passed. The build will still verify signing/notarization; clean-machine installation and signed upgrades require acceptance.'); }
    catch { console.error('Could not verify the deployed HTTPS workspace. Deploy it before building a release.'); process.exitCode=1; }
  }
}
