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
stopped=0
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
    compose up -d --no-deps --wait --wait-timeout 180 web web2 worker gateway
  fi
  echo "Previous revision $previous restored." >&2
  exit "$status"
}
trap rollback ERR
compose config --quiet
test -s "$state/backup-key.env"
old_worker=$(docker inspect --format '{{.Config.Image}}' "$(compose ps -q worker)")
docker image inspect "$old_worker" >/dev/null
# Refuse low disk space before a build can displace a healthy running release.
available=$(df -Pk . | awk 'NR==2 {print $4}')
test "$available" -ge 8388608
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
docker run --rm --entrypoint node --env-file "$state/backup-key.env" \
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
compose ps
echo "Verified deployment $revision at https://$domain. Backup: $backup"
