import type { PoolConfig } from "pg";

export function databaseLimits(env:NodeJS.ProcessEnv = process.env): PoolConfig {
  const ms = (name:string, fallback:number) => {
    const value=Number(env[name]??fallback);
    if (!Number.isSafeInteger(value) || value<100 || value>300_000) throw new Error(`${name} must be between 100 and 300000 milliseconds.`);
    return value;
  };
  return {
    max:10,
    idleTimeoutMillis:ms("DB_IDLE_TIMEOUT_MS",30_000),
    connectionTimeoutMillis:ms("DB_CONNECT_TIMEOUT_MS",5_000),
    statement_timeout:ms("DB_STATEMENT_TIMEOUT_MS",30_000),
    lock_timeout:ms("DB_LOCK_TIMEOUT_MS",5_000),
    idle_in_transaction_session_timeout:ms("DB_IDLE_TRANSACTION_TIMEOUT_MS",15_000),
    // The deployment uses PostgreSQL 18 (transaction_timeout requires 17+).
    // Enforced by the server: no abandoned Promise.race query still holding locks.
    options:`-c transaction_timeout=${ms("DB_TRANSACTION_TIMEOUT_MS",60_000)}`,
    keepAlive:true,
    keepAliveInitialDelayMillis:10_000,
  };
}

export function isDatabaseBusy(error:unknown):boolean {
  return ["57014","55P03","40P01","40001","25P03","25P04","53300","57P01"].includes((error as {code?:string})?.code??"");
}

export function databaseConfig(connectionString:string,env:NodeJS.ProcessEnv=process.env):PoolConfig {
  const limits=databaseLimits(env);
  const url=new URL(connectionString);
  // pg lets URL options override the config object. Preserve search_path and
  // other deployment options while still enforcing the transaction deadline.
  url.searchParams.set("options",[url.searchParams.get("options")??env.PGOPTIONS,limits.options].filter(Boolean).join(" "));
  return {...limits,connectionString:url.toString()};
}
