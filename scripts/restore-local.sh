#!/usr/bin/env bash

# Restore one coordinated Animama self-host backup. This replaces live state
# only after an explicit --confirm and retains a rollback bundle.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=local-stack-state-common.sh
source "${script_dir}/local-stack-state-common.sh"

usage() {
  cat <<'EOF'
Usage: ./scripts/restore-local.sh BACKUP.tar.gz --confirm [--name NAME] [--stack-env-file PATH] [--rollback-dir DIR]

Restores PostgreSQL, content/local, and private data into one stopped/quiesced
stack, runs migrations, and performs an
authoritative content rescan. The current state is retained in a timestamped
rollback bundle before replacement.
EOF
}

archive=""
stack_name=""
stack_env_file=""
rollback_root=""
confirmed=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      confirmed=true
      shift
      ;;
    --name)
      [ "$#" -ge 2 ] || animama_state_die "missing value for --name"
      stack_name="$2"
      shift 2
      ;;
    --stack-env-file)
      [ "$#" -ge 2 ] || animama_state_die "missing value for --stack-env-file"
      stack_env_file="$2"
      shift 2
      ;;
    --rollback-dir)
      [ "$#" -ge 2 ] || animama_state_die "missing value for --rollback-dir"
      rollback_root="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*) animama_state_die "unknown argument: $1" ;;
    *)
      [ -z "$archive" ] || animama_state_die "only one backup archive may be restored"
      archive="$1"
      shift
      ;;
  esac
done

[ -n "$archive" ] || animama_state_die "a backup archive is required"
[ "$confirmed" = true ] || animama_state_die "restore replaces current state; rerun with --confirm"
[ -f "$archive" ] || animama_state_die "backup archive not found: $archive"

if [ -n "$stack_env_file" ]; then
  [ -f "$stack_env_file" ] || animama_state_die "stack env file not found: $stack_env_file"
  # shellcheck disable=SC1090
  source "$stack_env_file"
fi

animama_state_configure "$stack_name"
animama_state_require_stack
mkdir -p "$ANIMAMA_STATE_LOCAL_ROOT" "$ANIMAMA_STATE_DATA_ROOT"
animama_state_resolve_live_roots

if [ -z "$rollback_root" ]; then
  rollback_root="${ANIMAMA_STATE_REPO_ROOT}/backups/restore-rollbacks"
elif [[ "$rollback_root" != /* ]]; then
  rollback_root="${ANIMAMA_STATE_REPO_ROOT}/${rollback_root#./}"
fi
mkdir -p "$rollback_root"
case "$rollback_root/" in
  "$ANIMAMA_STATE_LOCAL_ROOT/"* | "$ANIMAMA_STATE_DATA_ROOT/"*)
    animama_state_die "rollback storage must be outside content/local and data"
    ;;
esac

animama_state_validate_tar_paths "$archive" outer
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/animama-restore.XXXXXX")"
tar -xzf "$archive" -C "$work_dir"
payload="${work_dir}/animama-backup"
for required in manifest.env SHA256SUMS postgres.dump content-local.tar.gz data.tar.gz; do
  [ -f "${payload}/${required}" ] || animama_state_die "backup is missing $required"
done
grep -qx 'ANIMAMA_BACKUP_FORMAT=animama-self-host-backup-v1' "${payload}/manifest.env" ||
  animama_state_die "unsupported backup format"

(
  cd "$payload"
  while read -r expected file; do
    [ -n "$expected" ] && [ -n "$file" ] || animama_state_die "invalid checksum file"
    actual="$(animama_state_sha256 "$file")"
    [ "$actual" = "$expected" ] || animama_state_die "checksum mismatch for $file"
  done < SHA256SUMS
)
animama_state_validate_tar_paths "${payload}/content-local.tar.gz" inner
animama_state_validate_tar_paths "${payload}/data.tar.gz" inner

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="${rollback_root}/${ANIMAMA_STATE_PROJECT}-${timestamp}"
mkdir -p "$rollback_dir"
resumed=false
replacement_started=false
cleanup() {
  status=$?
  if [ "$resumed" = false ] && [ "$replacement_started" = false ]; then
    animama_state_resume_services || true
  fi
  rm -rf -- "$work_dir"
  if [ "$status" -ne 0 ] && [ "$replacement_started" = true ]; then
    printf 'Restore did not complete. The pre-restore rollback bundle is at %s\n' "$rollback_dir" >&2
    printf 'Installed model assets may be held at %s/.restore-model-assets; rerunning the restore puts them back.\n' "$ANIMAMA_STATE_DATA_ROOT" >&2
    printf 'Application services remain stopped so damaged or partial state is never served.\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

animama_state_pause_services

# Capture a recoverable pre-restore point before changing any live bytes.
animama_state_compose exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "${rollback_dir}/postgres.dump"
tar -C "$ANIMAMA_STATE_LOCAL_ROOT" -czf "${rollback_dir}/content-local.tar.gz" .
tar -C "$ANIMAMA_STATE_DATA_ROOT" \
  --exclude='./internal/gateway/token' \
  --exclude='./internal/gateway/.gateway-token.*' \
  --exclude='./internal/chatgpt-plan' \
  --exclude='./internal/model-assets' \
  --exclude='./staging/model-assets' \
  --exclude='./.restore-model-assets' \
  -czf "${rollback_dir}/data.tar.gz" .
cp "${payload}/manifest.env" "${rollback_dir}/restored-backup-manifest.env"
chmod -R go-rwx "$rollback_dir"

printf 'Replacing state for stack %s:\n' "$ANIMAMA_STATE_PROJECT"
printf '  Local content: %s\n' "$ANIMAMA_STATE_LOCAL_ROOT"
printf '  private data: %s\n' "$ANIMAMA_STATE_DATA_ROOT"
printf '  PostgreSQL: compose service postgres\n'
replacement_started=true

find "$ANIMAMA_STATE_LOCAL_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
tar -xzf "${payload}/content-local.tar.gz" -C "$ANIMAMA_STATE_LOCAL_ROOT"
animama_state_replace_data_root "${payload}/data.tar.gz"

animama_state_compose exec -T postgres sh -c \
  'pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "${payload}/postgres.dump"

# Restore may come from an older compatible app revision. Upgrade first, then
# rebuild filesystem-derived catalog state before accepting application writes.
animama_state_compose run --rm --no-deps animama-server alembic upgrade head
animama_state_compose run --rm --no-deps animama-server python -m animama.server.content_cli

animama_state_resume_services
resumed=true
printf 'Restore complete for stack %s.\n' "$ANIMAMA_STATE_PROJECT"
printf 'Pre-restore rollback retained at: %s\n' "$rollback_dir"
printf 'Environment secrets and Included content must match this application installation.\n'
