# The agent-run worker image.
#
# It runs `worker/index.ts` (via tsx) and spawns the agent CLIs, so it needs
# Node, git — the run layer shells out to git for clone/commit/merge — and the
# CLIs themselves. It is NOT the web server: there is no Next build here, just
# the queue consumer. See the `worker` service in docker-compose.yml for how it
# is wired (shared data root at an identical path, mounted CLI credentials,
# compose-network Redis/Postgres).
#
# NOTE: this image is provided for the containerized (Slice-2) deployment and is
# not exercised by local development, which runs the worker on the host via
# `AGENT_WORKER=1 ./start.sh`.
FROM node:22-slim

# git: repo.ts drives git via execFile. build tools + python3: some deps carry
# native addons (e.g. node-pty) that fall back to node-gyp when no prebuild
# matches the platform. ca-certificates: the CLIs' HTTPS calls to their vendors.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, for layer caching. --include=dev because the worker runs
# through tsx, which is a devDependency.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# The agent CLIs the worker spawns. Keep this in step with the agents enabled in
# app/lib/ai/catalog.ts; pin versions for reproducible images.
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli

COPY . .

# Unbuffered logs so `docker logs multiplayer-worker` shows run progress live.
ENV NODE_ENV=production
CMD ["npm", "run", "worker"]
