export function serverWorkers(env = process.env) {
  const workers = Number(env.WEB_CONCURRENCY ?? 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new Error('WEB_CONCURRENCY must be an integer from 1 to 16.');
  }
  if (workers > 1 && (!env.REDIS_URL || env.LOCAL_RUNNERS !== '1' || env.MULTIPLAYER_AI_TERMINAL !== '0')) {
    throw new Error('Multiple web processes require REDIS_URL, LOCAL_RUNNERS=1 and MULTIPLAYER_AI_TERMINAL=0. Local terminals and inline agents require a single process.');
  }
  return workers;
}
