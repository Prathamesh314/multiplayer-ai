export function serverWorkers(env = process.env) {
  if (env.API_TRUST_PROXY === '1' && (!env.REDIS_URL || (env.PROXY_SHARED_SECRET?.length ?? 0) < 32)) {
    throw new Error('Trusted proxy deployment requires REDIS_URL and PROXY_SHARED_SECRET of at least 32 characters.');
  }
  const workers = Number(env.WEB_CONCURRENCY ?? 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new Error('WEB_CONCURRENCY must be an integer from 1 to 16.');
  }
  if (workers > 1 && (!env.REDIS_URL || env.LOCAL_RUNNERS !== '1' || env.MULTIPLAYER_AI_TERMINAL !== '0')) {
    throw new Error('Multiple web processes require REDIS_URL, LOCAL_RUNNERS=1 and MULTIPLAYER_AI_TERMINAL=0. Local terminals and inline agents require a single process.');
  }
  return workers;
}
