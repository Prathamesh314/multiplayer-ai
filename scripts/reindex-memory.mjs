// Rebuild a disposable semantic index from approved Postgres records.
// This only queues delivery; the normal worker owns provider access and retries.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import pg from "pg";

nextEnv.loadEnvConfig(dirname(dirname(fileURLToPath(import.meta.url))), process.env.NODE_ENV !== "production");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const client = new pg.Client({connectionString:process.env.DATABASE_URL});
try {
  await client.connect();
  const result=await client.query(`INSERT INTO memory_jobs(memory_id,operation,revision)
    SELECT m.id,'index',m.revision FROM memory_records m JOIN sessions s ON s.id=m.room_id
    WHERE m.status='approved' AND memory_source_live(m) AND s.deleted_at IS NULL
      AND m.org_id IS NOT DISTINCT FROM s.org_id AND m.project_id IS NOT DISTINCT FROM s.project_id
      AND (m.parent_id IS NULL OR EXISTS (SELECT 1 FROM memory_records p WHERE p.id=m.parent_id
        AND p.status='approved' AND memory_source_live(p)))
    ON CONFLICT(memory_id,operation) DO UPDATE SET revision=EXCLUDED.revision,
      attempts=0,retry_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL`);
  console.log(`Queued ${result.rowCount} approved memories. Run npm run worker to deliver them.`);
} finally {await client.end();}
