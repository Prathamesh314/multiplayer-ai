# The background worker image.
#
# It runs `worker/index.ts` (via tsx): memory jobs and repository indexing,
# which read Git objects from the shared data root. It never runs an AI agent —
# those run only on members' own computers, through the desktop app or runner —
# so it has no agent CLIs or credentials. It is NOT the web server: there is no
# Next build here. See the `worker` service in docker-compose.yml for how it is
# wired (shared data root at an identical path, compose-network Redis/Postgres).
FROM node:24-slim

# git: repo.ts drives git via execFile. build tools + python3: some deps carry
# native addons (e.g. node-pty) that fall back to node-gyp when no prebuild
# matches the platform. ca-certificates: the CLIs' HTTPS calls to their vendors.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, for layer caching. --include=dev because the worker runs
# through tsx, which is a devDependency. Node 24 requires C++20 when compiling
# older tree-sitter bindings on platforms without a matching prebuilt binary.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    CXXFLAGS=-std=c++20 npm_package_config_node_gyp_nodedir=/usr/local ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --include=dev

# No AI command-line tools: the worker indexes repositories and memory; agents
# run only on members' own computers, through the desktop app or runner.

COPY . .

# Unbuffered logs so `docker logs multiplayer-worker` shows progress live.
ENV NODE_ENV=production
CMD ["npm", "run", "worker"]
