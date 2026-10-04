#!/usr/bin/env bash
# Install outside the checkout as /usr/local/sbin/multiplayer-ci-deploy.
# The dedicated authorized_keys entry must use restrict,command="...".
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy <40-character commit SHA> is allowed.' >&2
  exit 64
fi
revision=${BASH_REMATCH[1]}
cd /opt/multiplayer-ai
exec 9>/var/lock/multiplayer-deploy.lock
flock -w 1800 9
test -z "$(git status --porcelain --untracked-files=normal)"
previous=$(git rev-parse HEAD)
scratch=$(mktemp -d /var/tmp/multiplayer-deploy.XXXXXXXX)
trap 'rm -rf "$scratch"' EXIT
# Bound both upload time and size (512 MiB); no arbitrary paths or commands.
(ulimit -f 524288; timeout 180 cat > "$scratch/release.bundle")
git bundle verify "$scratch/release.bundle"
test "$(git bundle list-heads "$scratch/release.bundle" HEAD)" = "$revision HEAD"
git fetch --no-tags "$scratch/release.bundle" HEAD
git merge-base --is-ancestor "$previous" "$revision"
git checkout --detach "$revision"
if ! bash scripts/deploy-production.sh "$revision" "$previous"; then
  echo "Deployment failed for $revision; see the release log and backup." >&2
  exit 1
fi
