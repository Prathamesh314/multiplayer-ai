import { stat } from "node:fs/promises";
import { query,queryOne } from "../db/client";
import { gitStorageConfig,type RepoKey } from "./config";
import { gitStorageService } from "./service";

/** Migration writes are retryable and use the same fencing as live writes.
 * Run only on the host holding legacy repos, while shadow mode is enabled. */
export async function processGitBackfill():Promise<boolean> {
  if(gitStorageConfig().mode!=='shadow') return false;
  const job=await queryOne<{repo_key:RepoKey}>(`SELECT repo_key FROM git_storage_jobs WHERE retry_at<=now() ORDER BY retry_at LIMIT 1`);
  if(!job) return false;
  try {
    const service=await gitStorageService();
    await service.withRepositories([job.repo_key],true,async()=>{
      if(!await stat(service.bare(job.repo_key)).then(s=>s.isDirectory(),()=>false)) throw new Error('Legacy bare repository is missing; backfill refused.');
    },{maintenance:true});
    await query(`DELETE FROM git_storage_jobs WHERE repo_key=$1`,[job.repo_key]);
  } catch(cause) {
    await query(`UPDATE git_storage_jobs SET attempts=attempts+1,retry_at=now()+interval '30 seconds',last_error=$2 WHERE repo_key=$1`,
      [job.repo_key,cause instanceof Error?cause.message.slice(0,500):'Backfill failed']);
  }
  return true;
}
