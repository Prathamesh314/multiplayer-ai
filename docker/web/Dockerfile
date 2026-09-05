# The web server image (Next.js) for the containerized deployment.
#
# Day-to-day development stays on `./start.sh` (host), which keeps Next's HMR
# fast — containerizing the dev server drags file-watching across the VM
# boundary and makes edits laggy. This image is the staging/production build:
# a production `next start`, no HMR.
#
# It serves the UI + API and performs local git READS on the shared workspace
# volume (diff/branch, and `ensureWork` on a file GET), so it needs git even
# though the worker does the heavy CLI execution. It also probes the agent CLIs
# to show the composer what's installed and signed in — without them the panel
# has no agent to select — so the CLIs are installed here as well; they simply
# *run* in the worker.

# --- build stage: compile the Next app --------------------------------------
FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage ----------------------------------------------------------
FROM node:22-slim
# git: local git reads on the shared volume. build tools: node-pty and other
# native addons compile on install. ca-certificates: the CLIs' HTTPS calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Production dependencies only; `next` itself is a runtime dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The agent CLIs the composer probes for installed/login state. Keep in step
# with app/lib/ai/catalog.ts; pin versions for reproducible images.
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli

# The built app and the bits `next start` and the migration runner need.
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.ts ./
COPY db ./db

ENV NODE_ENV=production
EXPOSE 3000

# Apply migrations, then serve on all interfaces (so the published port reaches
# it) at 3000. Migrations here are fine for a single web instance; a multi-
# replica deploy would run them as a separate one-shot step instead.
CMD ["sh", "-c", "node db/migrate.mjs && node_modules/.bin/next start -H 0.0.0.0 -p 3000"]
