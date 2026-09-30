import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const { cleanLegacyWork, pruneCheckpoints } = await import("../app/lib/storage/maintenance");
  const { trimGitCache } = await import("../app/lib/storage/git-cache");
  console.table(await cleanLegacyWork(process.argv.includes("--apply")));
  if (process.argv.includes("--apply")) console.log(`Pruned ${await pruneCheckpoints()} old checkpoints (latest and selected checkpoints retained).`);
  if (process.argv.includes("--trim")) console.log(await trimGitCache());
  const { pool } = await import("../app/lib/db/client");
  const { repoLock } = await import("../app/lib/session/lock");
  await pool().end(); await (await repoLock()).close();
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
