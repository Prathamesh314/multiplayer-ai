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
rollback() {
  local status=$?
  trap - ERR
  echo "Release failed (exit $status)." >&2
  if [[ $migrating = 1 ]]; then
    local current_schema
    if ! current_schema=$(schema) || [[ $current_schema != "$before_schema" ]]; then
      compose stop --timeout 30 gateway web web2 worker || true
      echo "Schema changed or could not be verified. Services remain stopped; recover using $release and $backup. Old code was not started against a changed database." >&2
      exit "$status"
    fi
  fi
  cp -p "$release/environment.before" .env.production
  git checkout --detach "$previous"
  if [[ $stopped = 1 ]]; then
    if [[ $initially_stopped = 1 ]]; then
      compose stop --timeout 30 gateway web web2 worker
      echo 'The previous release was already stopped; application services remain stopped.' >&2
    else
      compose up -d --no-deps --wait --wait-timeout 180 web web2 worker gateway
    fi
  fi
  echo "Previous revision $previous restored." >&2
  exit "$status"
}
trap rollback ERR
compose config --quiet
test -s "$state/backup-key.env"
if [[ -z "$(compose ps --status running -q web web2 worker gateway)" ]]; then initially_stopped=1; fi
# A failed post-migration bootstrap deliberately leaves writers stopped. Retain
# access to their image so the corrected release can back up and resume safely.
old_worker=$(docker inspect --format '{{.Config.Image}}' "$(compose ps --all -q worker)")
old_web=$(docker inspect --format '{{.Config.Image}}' "$(compose ps --all -q web)")
[[ $old_web = multiplayer-web:* ]]
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
before_schema=$(schema)
awk -v revision="$revision" '/^APP_VERSION=/ { print "APP_VERSION=" revision; found=1; next } { print } END { if (!found) print "APP_VERSION=" revision }' .env.production > "$release/environment.next"
cp "$release/environment.next" .env.production
compose config --quiet
migrating=1
compose rm -f migrate
compose run --rm --no-deps -T migrate
# Populate durable storage counters while every old writer is stopped. Subsequent
# releases only initialize new owners; normal admission never does an org scan.
compose run --rm --no-deps -T worker node --import tsx scripts/storage-accounting.ts --bootstrap
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
trap - ERR
# The new release is healthy and its revision is recorded. Remove the superseded
# images now, never before verification. A cleanup failure must not roll back a
# healthy release after its previous images may already have been deleted.
if ! cleanup_images; then
  echo "Deployment $revision is healthy, but Docker cleanup failed. Retry cleanup; do not roll back the application." >&2
  exit 1
fi
compose ps
echo "Verified deployment $revision at https://$domain. Backup: $backup"
