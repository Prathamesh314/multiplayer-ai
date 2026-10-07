import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
async function main() {
  const { initializeOwner, reconcileOwnerStorage, recoverStorageReservations } = await import("../app/lib/storage/accounting");
  const { query, pool } = await import("../app/lib/db/client");
  const mode = process.argv[2];
  if (!["--bootstrap", "--reconcile", "--recover"].includes(mode)) throw new Error("Usage: storage-accounting.ts --bootstrap | --reconcile | --recover");
  try {
    if (mode === "--recover") {
      const result = await recoverStorageReservations();
      console.log(result);
      if (result.failed.length) process.exitCode = 1;
      return;
    }
    const owners = await query<{ owner: string }>(`SELECT DISTINCT COALESCE('org:'||org_id::text,'user:'||owner_id::text) AS owner FROM sessions
      UNION SELECT 'org:'||org_id::text FROM projects UNION SELECT owner FROM storage_usage`);
    for (const { owner } of owners) {
      if (mode === "--bootstrap") await initializeOwner(owner);
      else console.log({ owner, bytes: await reconcileOwnerStorage(owner) });
    }
    console.log(`Storage accounting ready for ${owners.length} owner(s).`);
  } finally { await pool().end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
