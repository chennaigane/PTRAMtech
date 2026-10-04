#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_PATH:?DATABASE_PATH required}"
: "${RESTIC_REPOSITORY:?Off-host RESTIC_REPOSITORY required}"
case "$RESTIC_REPOSITORY" in
  sftp:*|s3:*|b2:*|rest:https://*) ;;
  *) echo 'Configure a remote encrypted restic repository; local paths are not accepted.' >&2; exit 1 ;;
esac
snapshot_dir=$(mktemp -d /srv/ptraam/data/backup-staging.XXXXXXXX)
snapshot_file="$snapshot_dir/ptraam.sqlite"
cleanup() { rm -f -- "$snapshot_file"; rmdir -- "$snapshot_dir"; }
trap cleanup EXIT
/usr/bin/node /srv/ptraam/app/scripts/backup-database.mjs "$snapshot_file"
/usr/bin/restic backup --stdin --stdin-filename ptraam.sqlite --tag ptraam-db < "$snapshot_file"
/usr/bin/restic check
# No automatic pruning: approve the company's retention policy first.
