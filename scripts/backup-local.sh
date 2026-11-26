#!/usr/bin/env bash

# Create one coordinated backup of PostgreSQL, content/local, and data.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=local-stack-state-common.sh
source "${script_dir}/local-stack-state-common.sh"

usage() {
  cat <<'EOF'
Usage: ./scripts/backup-local.sh [--name NAME] [--stack-env-file PATH] [--output DIR]

Creates a quiesced Animama self-host backup containing PostgreSQL,
content/local, and private data. Included content, browser caches, model
caches, downloaded model assets, environment secrets, the ChatGPT plan
session and legacy gateway credentials are excluded.
EOF
}

stack_name=""
stack_env_file=""
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --output)
      [ "$#" -ge 2 ] || animama_state_die "missing value for --output"
      output_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) animama_state_die "unknown argument: $1" ;;
  esac
done

if [ -n "$stack_env_file" ]; then
  [ -f "$stack_env_file" ] || animama_state_die "stack env file not found: $stack_env_file"
  # shellcheck disable=SC1090
  source "$stack_env_file"
fi

animama_state_configure "$stack_name"
animama_state_require_stack
[ -d "$ANIMAMA_STATE_LOCAL_ROOT" ] || animama_state_die "Local content root not found: $ANIMAMA_STATE_LOCAL_ROOT"
[ -d "$ANIMAMA_STATE_DATA_ROOT" ] || animama_state_die "private data root not found: $ANIMAMA_STATE_DATA_ROOT"
animama_state_resolve_live_roots

if [ -z "$output_dir" ]; then
  output_dir="${ANIMAMA_STATE_REPO_ROOT}/backups"
elif [[ "$output_dir" != /* ]]; then
  output_dir="${ANIMAMA_STATE_REPO_ROOT}/${output_dir#./}"
fi
mkdir -p "$output_dir"
case "$output_dir/" in
  "$ANIMAMA_STATE_LOCAL_ROOT/"* | "$ANIMAMA_STATE_DATA_ROOT/"*)
    animama_state_die "backup output must be outside content/local and data"
    ;;
esac

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${output_dir}/animama-${ANIMAMA_STATE_PROJECT}-${timestamp}.tar.gz"
[ ! -e "$archive" ] || animama_state_die "backup already exists: $archive"

work_dir="$(mktemp -d "${output_dir}/.animama-backup.XXXXXX")"
payload="${work_dir}/animama-backup"
mkdir -p "$payload"
resumed=false
cleanup() {
  status=$?
  if [ "$resumed" = false ]; then
    animama_state_resume_services || true
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

animama_state_pause_services
animama_state_compose exec -T postgres sh -c \
  'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "${payload}/postgres.dump"
tar -C "$ANIMAMA_STATE_LOCAL_ROOT" -czf "${payload}/content-local.tar.gz" .
tar -C "$ANIMAMA_STATE_DATA_ROOT" \
  --exclude='./internal/gateway/token' \
  --exclude='./internal/gateway/.gateway-token.*' \
  --exclude='./internal/chatgpt-plan' \
  --exclude='./internal/model-assets' \
  --exclude='./staging/model-assets' \
  --exclude='./.restore-model-assets' \
  -czf "${payload}/data.tar.gz" .

git_revision="unknown"
if command -v git >/dev/null 2>&1; then
  git_revision="$(git -C "$ANIMAMA_STATE_REPO_ROOT" rev-parse --verify HEAD 2>/dev/null || printf unknown)"
fi
cat > "${payload}/manifest.env" <<EOF
ANIMAMA_BACKUP_FORMAT=animama-self-host-backup-v1
ANIMAMA_BACKUP_CREATED_AT=${created_at}
ANIMAMA_BACKUP_STACK=${ANIMAMA_STATE_PROJECT}
ANIMAMA_BACKUP_GIT_REVISION=${git_revision}
ANIMAMA_BACKUP_INCLUDED=postgres,content-local,data
ANIMAMA_BACKUP_EXCLUDED=content-included,browser-cache,model-cache,downloaded-model-assets,secrets,gateway-token,chatgpt-plan-session
EOF

(
  cd "$payload"
  for file in postgres.dump content-local.tar.gz data.tar.gz manifest.env; do
    printf '%s  %s\n' "$(animama_state_sha256 "$file")" "$file"
  done > SHA256SUMS
)

partial="${archive}.partial"
tar -C "$work_dir" -czf "$partial" animama-backup
chmod 600 "$partial"
mv "$partial" "$archive"

animama_state_resume_services
resumed=true
printf 'Backup complete: %s\n' "$archive"
printf 'Backed up PostgreSQL, %s, and %s.\n' "$ANIMAMA_STATE_LOCAL_ROOT" "$ANIMAMA_STATE_DATA_ROOT"
printf 'Included content, browser/model caches, and legacy gateway credentials were not backed up.\n'
