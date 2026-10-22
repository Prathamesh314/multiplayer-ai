# The web server image (Next.js) for the containerized deployment.
#
# Day-to-day development stays on `./start.sh` (host), which keeps Next's HMR
# fast — containerizing the dev server drags file-watching across the VM
# boundary and makes edits laggy. This image is the staging/production build:
# a production `next start`, no HMR.
#
# It serves the UI + API and drives git against the bare repositories on the
# shared data root (diffs, merges, promotion), so it needs git. It never runs an
# AI agent and has no agent CLIs: agents run only on members' own computers,
# which report which CLIs they have.

# --- build stage: compile the Next app --------------------------------------
FROM node:24-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# The Node image includes matching native-module headers. No desktop binary is
# needed to build the hosted web app. Cache package downloads across rebuilds.
# Older tree-sitter bindings select C++17, but Node 24 headers require C++20.
RUN --mount=type=cache,target=/root/.npm \
    CXXFLAGS=-std=c++20 npm_package_config_node_gyp_nodedir=/usr/local ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
ARG DESKTOP_DOWNLOAD_MAC_URL
ARG DESKTOP_DOWNLOAD_MAC_INTEL_URL
ARG DESKTOP_DOWNLOAD_WINDOWS_URL
ARG DESKTOP_DOWNLOAD_LINUX_URL
ARG DESKTOP_DOWNLOAD_LINUX_DEB_URL
ARG DESKTOP_DOWNLOAD_CHANNEL
ARG DESKTOP_DOWNLOAD_CHECKSUMS_URL
ARG NEXT_PUBLIC_ASSET_PREFIX
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN npm run build -- --webpack

# --- runtime stage ----------------------------------------------------------
FROM node:24-slim
# git: local git reads on the shared volume. build tools: node-pty and other
# native addons compile on install. ca-certificates: the CLIs' HTTPS calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Production dependencies only; `next` itself is a runtime dependency.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    CXXFLAGS=-std=c++20 npm_package_config_node_gyp_nodedir=/usr/local npm ci --omit=dev

# No AI command-line tools: agents run only on members' own computers, through
# the desktop app or runner. This image never runs one.

# The built app and the bits `next start` and the migration runner need.
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.ts ./
COPY db ./db
COPY scripts/serve.mjs scripts/server-config.mjs scripts/check-web-runtime.mjs ./scripts/

# Keep the configuration consistent when Next loads next.config.ts at runtime.
ARG NEXT_PUBLIC_ASSET_PREFIX
ENV NEXT_PUBLIC_ASSET_PREFIX=$NEXT_PUBLIC_ASSET_PREFIX

ENV NODE_ENV=production
EXPOSE 3000

# Apply migrations, then serve on all interfaces (so the published port reaches
# it) at 3000. Migrations here are fine for a single web instance; a multi-
# replica deploy would run them as a separate one-shot step instead.
CMD ["sh", "-c", "node db/migrate.mjs && exec node scripts/serve.mjs -H 0.0.0.0 -p 3000"]
