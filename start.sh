#!/usr/bin/env bash
#
# One command to bring up the whole multiplayer-ai stack:
#
#   ./start.sh            services (Postgres, Redis, pgAdmin, Mnemosyne) → migrate → dev server
#   ./start.sh down       stop the services, keep the data
#   ./start.sh reset      stop and WIPE the database, then start fresh
#   ./start.sh services   just the Docker services + migrations, no dev server
#
# Mnemosyne (the semantic memory sidecar) is optional: the app degrades to
# fork + @room/chat context when it is absent, so startup never blocks on it —
# its first build pulls an embedding model and finishes in the background.
#
# Ctrl+C stops the dev server; the Docker services keep running so the next
# start is instant. Use `./start.sh down` when you want them gone.

set -euo pipefail

# Always operate from the repo root, wherever the script is called from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BLUE=''; GREEN=''; YELLOW=''; RED=''; DIM=''; RESET=''
fi
step() { printf '%s▸ %s%s\n' "$BLUE" "$1" "$RESET"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

PG_CONTAINER="multiplayer-postgres"

# Set by check_docker: how to invoke Compose on this machine. Prefer the v2
# subcommand ("docker compose"); fall back to the standalone v1 binary
# ("docker-compose") when that is all that is installed.
COMPOSE=""

# Runs Compose whichever way this machine has it.
dc() {
  if [ "$COMPOSE" = "plugin" ]; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

# --- prerequisites ----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

check_docker() {
  need docker "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"

  if docker compose version >/dev/null 2>&1; then
    COMPOSE="plugin"
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE="standalone"
    warn "Using the legacy docker-compose v1 binary. Upgrading to Compose v2 is recommended."
  else
    die "Docker Compose is required (neither 'docker compose' nor 'docker-compose' is available)."
  fi

  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and try again."
}

# --- env --------------------------------------------------------------------
ensure_env() {
  if [ ! -f .env ]; then
    step "No .env found — copying .env.example"
    cp .env.example .env
    ok "Created .env (development defaults)"
  fi
  # Export the vars so the migration runner and dev server see DATABASE_URL etc.
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

# --- docker services --------------------------------------------------------
compose_up() {
  step "Starting services (Postgres, Redis, pgAdmin, Mnemosyne)"
  # Brings up every compose service. On the very first run this also builds the
  # Mnemosyne image and pulls its embedding model, which can take a few minutes;
  # the app starts regardless and picks memory up once the sidecar is ready.
  dc up -d
  ok "Containers up"
}

wait_for_postgres() {
  step "Waiting for Postgres to be ready"
  local tries=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo none)" = "healthy" ]; do
    tries=$((tries + 1))
    [ "$tries" -gt 60 ] && die "Postgres did not become healthy in time. Check its logs, e.g. 'docker logs $PG_CONTAINER'."
    printf '%s  …still starting (%ss)%s\r' "$DIM" "$tries" "$RESET"
    sleep 1
  done
  printf '\r%s\r' "                                   "
  ok "Postgres is healthy"
}

# --- app --------------------------------------------------------------------
ensure_deps() {
  if [ ! -d node_modules ]; then
    step "Installing npm dependencies (first run)"
    npm install
    ok "Dependencies installed"
  fi
}

run_migrations() {
  step "Applying database migrations"
  node db/migrate.mjs
  ok "Schema up to date"
}

start_services() {
  check_docker
  ensure_env
  compose_up
  wait_for_postgres
  ensure_deps
  run_migrations
  printf '\n'
  ok "Stack is ready"
  printf '%s   Postgres  %s\n' "$DIM" "${DATABASE_URL:-postgres://localhost:5432}${RESET}"
  printf '%s   pgAdmin   http://localhost:%s%s\n' "$DIM" "${PGADMIN_PORT:-5050}" "$RESET"
  printf '%s   Redis     %s%s\n' "$DIM" "${REDIS_URL:-redis://localhost:6380}" "$RESET"
  printf '%s   Memory    %s%s\n' "$DIM" "${MNEMOSYNE_URL:-disabled (set MNEMOSYNE_URL to enable)}" "$RESET"
}

# --- subcommands ------------------------------------------------------------
case "${1:-up}" in
  up)
    start_services
    printf '\n'
    step "Starting the Next.js app (frontend + backend) — Ctrl+C to stop"
    printf '%s   http://localhost:3000%s\n\n' "$GREEN" "$RESET"
    exec npm run dev
    ;;

  services)
    start_services
    printf '\n%sServices are up. Start the app yourself with: %snpm run dev%s\n' "$DIM" "$RESET" "$RESET"
    ;;

  down)
    check_docker
    step "Stopping services (data is kept)"
    dc down
    ok "Stopped. Data volumes are preserved — run ./start.sh to bring it back."
    ;;

  reset)
    check_docker
    warn "This wipes the database. All orgs, projects, rooms and runs will be lost."
    printf 'Type %syes%s to continue: ' "$YELLOW" "$RESET"
    read -r answer
    [ "$answer" = "yes" ] || die "Aborted."
    step "Removing containers and volumes"
    dc down -v
    ok "Wiped. Starting fresh…"
    printf '\n'
    start_services
    printf '\n'
    step "Starting the Next.js app — Ctrl+C to stop"
    printf '%s   http://localhost:3000%s\n\n' "$GREEN" "$RESET"
    exec npm run dev
    ;;

  *)
    die "Unknown command '$1'. Use: up | services | down | reset"
    ;;
esac
