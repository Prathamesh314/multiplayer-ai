#!/usr/bin/env bash
# Called under the SSH entrypoint's exclusive lock after validating the bundle.
set -Eeuo pipefail
umask 077
revision=${1:?Expected checked revision}
previous=${2:?Expected previous revision}
[[ $revision =~ ^[0-9a-f]{40}$ && $previous =~ ^[0-9a-f]{40}$ ]]
cd "$(dirname "$0")/.."
test "$(git rev-parse HEAD)" = "$revision"
state=${DEPLOY_STATE_DIR:-/root/multiplayer-deployment-config}
backups=${DEPLOY_BACKUP_DIR:-/root/multiplayer-backups}
mkdir -p "$state" "$backups"
release="$state/release-$revision-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$release"
cp -p .env.production "$release/environment.before"
compose_files=(-f compose.production.yml)
if [[ -f compose.https.yml ]]; then compose_files+=(-f compose.https.yml); fi
compose() { docker compose --env-file .env.production "${compose_files[@]}" "$@"; }
query() { compose exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"' sh "$1"; }
schema() { query "SELECT version FROM schema_migrations ORDER BY version"; }
cleanup_images() {
  # Docker preserves images referenced by any container, including the current
  # release we may need to restart on failure. Never prune containers or volumes.
  echo 'Removing unused Docker images and limiting unused build cache to 2 GB.'
  docker image prune --all --force || return
  docker builder prune --all --force --keep-storage 2GB || return
}
stopped=0
initially_stopped=0
migrating=0
before_schema=''
candidate=''
cleanup_candidate() {
  if [[ -n $candidate ]]; then
    docker rm -f "$candidate" >/dev/null || return
    candidate=''
  fi
}
rollback() {
  local status=${1:-$?}
  # A failed command substitution is handled once by its parent ERR trap.
  if (( BASH_SUBSHELL > 0 )); then exit "$status"; fi
  trap - ERR INT TERM HUP
  cleanup_candidate || true
  echo "Release failed (exit $status)." >&2
  if [[ $migrating = 1 ]]; then
    local current_schema
    if ! current_schema=$(schema) || ! printf '%s\n' "$current_schema" | docker run --rm -i --network none \
      -v "$release/migration-plan.json:/plan.json:ro" "multiplayer-worker:$revision" node scripts/deploy-schema.mjs --rollback /plan.json; then
      compose stop --timeout 30 gateway web web2 worker || true
      echo "Schema compatibility could not be verified. Services remain stopped; recover using $release and $backup. No data was restored or deleted." >&2
      exit "$status"
    fi
  fi
  # Fence candidate writers before restarting old code. In particular, never
  # overlap pre-ledger writers with a partially activated accounting release.
  if [[ $stopped = 1 ]]; then compose stop --timeout 30 gateway web web2 worker; fi
  cp -p "$release/environment.before" .env.production
  git checkout --detach "$previous"
  # Images can differ from APP_VERSION after an earlier failed release. Pin the
  # actual previous containers' images rather than guessing a rollback tag.
  if [[ -f $release/rollback-images.json ]]; then compose_files+=(-f "$release/rollback-images.json"); fi
  if [[ $stopped = 1 ]]; then
    if [[ $initially_stopped = 1 ]]; then
      echo 'The previous release was already stopped; application services remain stopped.' >&2
    else
      compose up -d --no-deps --wait --wait-timeout 180 web web2 worker gateway
      for service in web web2; do compose exec -T "$service" node -e 'fetch("http://127.0.0.1:3000/health/ready",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; done
    fi
  fi
  echo "Previous revision $previous restored." >&2
  exit "$status"
}
trap rollback ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM HUP
trap 'cleanup_candidate || true' EXIT
compose config --quiet
test -s "$state/backup-key.env"
if [[ -z "$(compose ps --status running -q web web2 worker gateway)" ]]; then initially_stopped=1; fi
# A failed post-migration bootstrap deliberately leaves writers stopped. Retain
# access to their image so the corrected release can back up and resume safely.
old_worker=$(docker inspect --format '{{.Config.Image}}' "$(compose ps --all -q worker)")
old_web=$(docker inspect --format '{{.Config.Image}}' "$(compose ps --all -q web)")
[[ $old_web =~ ^multiplayer-web:[a-zA-Z0-9_.-]+$ && $old_worker =~ ^multiplayer-worker:[a-zA-Z0-9_.-]+$ ]]
printf '{"services":{"web":{"image":"%s"},"web2":{"image":"%s"},"worker":{"image":"%s"}}}\n' "$old_web" "$old_web" "$old_worker" > "$release/rollback-images.json"
docker image inspect "$old_worker" >/dev/null
cleanup_images
# Refuse low disk space before a build can displace a healthy running release.
available=$(df -Pk . | awk 'NR==2 {print $4}')
echo "Free disk after cleanup: $available KiB; deployment requires at least 8388608 KiB (8 GiB)."
if [[ ! $available =~ ^[0-9]+$ ]] || [[ "$available" -lt 8388608 ]]; then
  echo 'Not enough disk space to deploy after Docker cleanup. Free space or expand the VM disk; application data and backups were preserved.' >&2
  false
fi
echo "Building production images for $revision while the current release serves traffic."
APP_VERSION="$revision" compose build web worker
# Refuse unreviewed/incompatible migrations before changing traffic or data.
before_schema=$(schema)
printf '%s\n' "$before_schema" | docker run --rm -i --network none "multiplayer-worker:$revision" node scripts/deploy-schema.mjs --plan > "$release/migration-plan.json"
APP_VERSION="$revision" compose run --rm --no-deps -T worker node --import tsx scripts/storage-accounting.ts --check
# Boot a private candidate with no published ports while the current site serves
# traffic. Probe real Next startup and dependency readiness, then discard it.
candidate="multiplayer-preflight-${revision:0:12}-$(date +%s)"
APP_VERSION="$revision" compose run --rm --no-deps -d --name "$candidate" web
docker exec "$candidate" node scripts/check-web-runtime.mjs
cleanup_candidate
active=$(query "SELECT count(*) FROM agent_runs WHERE status IN ('queued','running')")
if [[ $active != 0 ]]; then
  echo 'Active AI work detected; retry this workflow once it finishes.' >&2
  false
fi
# Close admission and recheck so a turn cannot start between checking and backup.
stopped=1
compose stop --timeout 30 gateway
active=$(query "SELECT count(*) FROM agent_runs WHERE status IN ('queued','running')")
if [[ $active != 0 ]]; then
  echo 'AI work started while draining; preserving it and restoring admission.' >&2
  false
fi
backup="$backups/pre-$revision-$(date -u +%Y%m%dT%H%M%SZ)"
# After a failed release, .env.production can name an unused image just pruned
# above. Run backup inventory with the web image retained by its container.
docker run --rm --entrypoint node --env-file "$state/backup-key.env" \
  -e "APP_VERSION=${old_web#multiplayer-web:}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /usr/bin/docker:/usr/bin/docker:ro \
  -v /usr/libexec/docker/cli-plugins:/usr/libexec/docker/cli-plugins:ro \
  -v "$PWD:$PWD:ro" -v "$backups:$backups" -w "$PWD" "$old_worker" \
  scripts/backup.mjs create --output "$backup" --compose compose.production.yml --env-file .env.production
test -s "$backup/manifest.json"
compose stop --timeout 30 web web2 worker
# Detect external schema changes since the preflight. No migration has run yet.
migrating=1
test "$(schema)" = "$before_schema"
awk -v revision="$revision" '/^APP_VERSION=/ { print "APP_VERSION=" revision; found=1; next } { print } END { if (!found) print "APP_VERSION=" revision }' .env.production > "$release/environment.next"
cp "$release/environment.next" .env.production
compose config --quiet
compose rm -f migrate
compose run --rm --no-deps -T migrate
# A rollback may have run older writers that do not maintain the new counters.
# Reconcile with every writer stopped before enabling ledger-aware writes again.
compose run --rm --no-deps -T worker node --import tsx scripts/storage-accounting.ts --reconcile
# One-shot setup services deliberately excluded: successful exit is not unhealthy.
compose up -d --no-deps --wait --wait-timeout 180 web web2 worker gateway
for service in web web2; do
  actual=$(docker inspect --format '{{.Config.Image}}' "$(compose ps -q "$service")")
  test "$actual" = "multiplayer-web:$revision"
done
domain=$(sed -n 's/^APP_DOMAIN=//p' .env.production | tr -d '\r\"\047')
[[ $domain =~ ^[a-zA-Z0-9.-]+$ ]]
for route in / /login /workspace; do
  curl --fail --silent --show-error --location --retry 5 --retry-delay 3 --retry-all-errors --max-time 30 "https://$domain$route" -o /dev/null
done
printf '%s\n' "$revision" > "$state/deployed-revision"
trap - ERR INT TERM HUP
# The new release is healthy and its revision is recorded. Remove the superseded
# images now, never before verification. A cleanup failure must not roll back a
# healthy release after its previous images may already have been deleted.
if ! cleanup_images; then
  echo "Deployment $revision is healthy, but Docker cleanup failed. Retry cleanup; do not roll back the application." >&2
  exit 1
fi
compose ps
echo "Verified deployment $revision at https://$domain. Backup: $backup"
