import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, queryOne, transaction } from "../db/client";
import { gitStorageConfig, repoKey, type RepoKey } from "../git-storage/config";
import { gitStorageService, hashFile, storageGit, withGitRepositories, type RepositoryState } from "../git-storage/service";
import { LocalObjectStore } from "../git-storage/objects";
import { barePath, workPath } from "./paths";
import { withRepoLock } from "./repo";
import { markArchived, reapableSessions } from "./store";

type Backup = { backend: "local"|"cloud"; repositories: Array<{ key: RepoKey; bundle: string|null; hash: string|null }> };
export class RetentionError extends Error {
  constructor(message: string, readonly status=400) {super(message);}
}
const DAY=24*60*60*1000;
export function archiveAfterDays() {
  const value=Number(process.env.MULTIPLAYER_AI_ARCHIVE_DAYS);
  return Number.isFinite(value)&&value>0?value:7;
}
async function repositoryIds(id: string) {
  const rows=await query<{id:string}>(`SELECT id FROM room_repos WHERE session_id=$1`,[id]);
  return [id,...rows.map(row=>row.id)];
}
async function administrator(id: string,user: string) {
  const room=await queryOne<{id:string;name:string;deleted_at:Date|null}>(`SELECT s.id,s.name,s.deleted_at FROM sessions s
    WHERE s.id=$1 AND ((s.org_id IS NULL AND s.owner_id=$2) OR EXISTS (
      SELECT 1 FROM org_members m WHERE m.org_id=s.org_id AND m.user_id=$2
        AND m.status='active' AND m.role IN ('owner','admin')))`,[id,user]);
  if(!room) throw new RetentionError("An active organization admin (or personal-room owner) must authorize this action.",403);
  return room;
}
async function backupRepositories(ids: string[]): Promise<Backup> {
  const config=gitStorageConfig(),keys=ids.map(id=>repoKey(id));
  if(config.mode!=='local') {
    await (await gitStorageService()).checkpoint(keys);
    const rows=await query<RepositoryState>(`SELECT * FROM git_repositories WHERE repo_key=ANY($1::text[]) AND initialized`,[keys]);
    return {backend:'cloud',repositories:rows.map(row=>({key:row.repo_key,bundle:row.bundle_key,hash:row.bundle_sha256}))};
  }
  const store=new LocalObjectStore(join(config.cacheRoot,'archives'));
  const backup:Backup={backend:'local',repositories:[]};
  for(const id of ids) {
    const bare=barePath(id);
    if(!await stat(bare).then(()=>true,()=>false)) {
      const confirmed=await queryOne(`SELECT head_sha FROM session_repos WHERE session_id=$1 AND head_sha IS NOT NULL
        UNION ALL SELECT head_sha FROM room_repos WHERE id=$1 AND head_sha IS NOT NULL`,[id]);
      if(confirmed) throw new RetentionError('Confirmed repository is missing; restore it before archiving or deleting this room.',409);
      continue;
    }
    const refs=(await storageGit(bare,['for-each-ref','--format=%(refname)'])).trim();
    if(!refs) {backup.repositories.push({key:repoKey(id),bundle:null,hash:null});continue;}
    const file=join(config.cacheRoot,`.archive-${randomUUID()}.bundle`);
    try {
      await storageGit(bare,['bundle','create',file,'--all']);
      await storageGit(bare,['bundle','verify',file]);
      const hash=await hashFile(file),bundle=`bundles/${hash}.bundle`;
      await store.putFile(bundle,file);
      backup.repositories.push({key:repoKey(id),bundle,hash});
    } finally {await rm(file,{force:true});}
  }
  return backup;
}
async function withRoomRepositories<T>(id:string,task:(ids:string[])=>Promise<T>) {
  const ids=await repositoryIds(id);
  return withGitRepositories(ids.map(id=>repoKey(id)),false,()=>gitStorageConfig().mode==='local'
    ? withRepoLock(id,()=>task(ids)) : task(ids));
}
export async function archiveSession(id:string) {
  return withRoomRepositories(id,async ids=>{
    const running=await queryOne(`SELECT id FROM agent_runs WHERE session_id=$1 AND status IN ('running','queued') LIMIT 1`,[id]);
    if(running) return false;
    const backup=await backupRepositories(ids);
    await query(`INSERT INTO session_archives(session_id,backup) VALUES ($1,$2)
      ON CONFLICT(session_id) DO UPDATE SET backup=EXCLUDED.backup,created_at=now()`,[id,JSON.stringify(backup)]);
    for(const ref of ids) await rm(workPath(ref),{recursive:true,force:true});
    await markArchived(id);
    return true;
  });
}
export async function requestSessionDeletion(id:string,userId:string,confirmName:string) {
  const room=await administrator(id,userId);
  if(confirmName!==room.name) throw new RetentionError("Type the exact room name to confirm deletion.");
  const pending=await queryOne(`SELECT * FROM session_deletions WHERE session_id=$1 AND restored_at IS NULL`,[id]);
  if(pending) return pending;
  return withRoomRepositories(id,async ids=>{
    const running=await queryOne(`SELECT id FROM agent_runs WHERE session_id=$1 AND status IN ('running','queued') LIMIT 1`,[id]);
    if(running) throw new RetentionError("Wait for active runs to finish before deleting this room.",409);
    const backup=await backupRepositories(ids);
    // Recheck after slow backup uploads, before tombstoning.
    await administrator(id,userId);
    return transaction(async tx=>{
      await tx.query(`SELECT id FROM sessions WHERE id=$1 FOR UPDATE`,[id]);
      const {rows:[deletion]}=await tx.query(`INSERT INTO session_deletions(session_id,requested_by,backup)
        VALUES ($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET requested_by=$2,backup=$3,
          requested_at=now(),delete_after=now()+interval '7 days',completed_at=NULL,restored_at=NULL
        WHERE session_deletions.restored_at IS NOT NULL RETURNING *`,[id,userId,JSON.stringify(backup)]);
      await tx.query(`UPDATE sessions SET deleted_at=now() WHERE id=$1`,[id]);
      return deletion;
    });
  });
}
export async function restoreSession(id:string,userId:string) {
  await administrator(id,userId);
  return transaction(async tx=>{
  const {rows:[deletion]}=await tx.query<{backup:Backup}>(`SELECT backup FROM session_deletions WHERE session_id=$1 AND restored_at IS NULL FOR UPDATE`,[id]);
  if(!deletion) throw new RetentionError("No pending or completed deletion exists for this room.",404);
  if(deletion.backup.backend==='local') {
    if(gitStorageConfig().mode!=='local') throw new RetentionError("Restore this testing backup in the original local environment before migrating it.",409);
    const config=gitStorageConfig(),store=new LocalObjectStore(join(config.cacheRoot,'archives'));
    for(const item of deletion.backup.repositories) {
      const bare=join(config.cacheRoot,`${item.key}.git`);
      if(await stat(bare).then(()=>true,()=>false)) continue;
      await mkdir(dirname(bare),{recursive:true});
      if(!item.bundle) {await storageGit(dirname(bare),['init','--bare','-b','main',bare]);continue;}
      const file=join(config.cacheRoot,`.restore-${randomUUID()}.bundle`);
      try {
        await store.getFile(item.bundle,file);
        if(await hashFile(file)!==item.hash) throw new Error('Archive checksum mismatch.');
        await storageGit(dirname(bare),['clone','--mirror',file,bare]);
      } finally {await rm(file,{force:true});}
    }
  }
    await tx.query(`UPDATE sessions SET deleted_at=NULL,archived_at=NULL,last_active_at=now() WHERE id=$1`,[id]);
    await tx.query(`UPDATE session_deletions SET restored_at=now() WHERE session_id=$1`,[id]);
  });
}
export type SweepResult={archived:string[];deleted:string[]};
export async function sweep():Promise<SweepResult> {
  const result:SweepResult={archived:[],deleted:[]};
  for(const session of await reapableSessions()) {
    if(!session.pinned&&session.archivedAt===null&&session.lastActiveAt<Date.now()-archiveAfterDays()*DAY) {
      if(await archiveSession(session.id)) result.archived.push(session.id);
    }
  }
  const due=await query<{session_id:string;backup:Backup}>(`SELECT session_id,backup FROM session_deletions
    WHERE restored_at IS NULL AND completed_at IS NULL AND delete_after<=now()`);
  for(const deletion of due) {
    await transaction(async tx=>{
      const {rows:[locked]}=await tx.query(`SELECT session_id FROM session_deletions WHERE session_id=$1
        AND restored_at IS NULL AND completed_at IS NULL AND delete_after<=now() FOR UPDATE`,[deletion.session_id]);
      if(!locked) return;
      // Bundles and metadata remain restorable after this cache cleanup.
      for(const item of deletion.backup.repositories) {
        const id=item.key.slice(6);
        await rm(workPath(id),{recursive:true,force:true});
        await rm(barePath(id),{recursive:true,force:true});
      }
      await tx.query(`UPDATE session_deletions SET completed_at=now() WHERE session_id=$1`,[deletion.session_id]);
      result.deleted.push(deletion.session_id);
    });
  }
  return result;
}
let lastSweep=0,running:Promise<SweepResult>|null=null;
export function sweepInBackground() {
  if(running||Date.now()-lastSweep<10*60*1000) return;
  lastSweep=Date.now();running=sweep();
  void running.catch(cause=>console.warn('Retention retry required',cause instanceof Error?cause.message:cause)).finally(()=>{running=null;});
}
