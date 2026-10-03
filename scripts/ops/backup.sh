#!/usr/bin/env bash
#
# 일일 백업: agent_memory 스키마 pg_dump -Fc, 역할 정의, 체크섬, 행 수 매니페스트
#
# 작성자: 최진호
# 작성일: 2026-10-03
#
# 접속 값은 표준 PG 환경변수(PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD, PGPASSFILE)
# 또는 명령줄 인자로만 받는다. 비밀번호는 인자로 받지 않는다. 저장소의 환경 파일은 읽지 않는다.
#
# 저장 위치: --dir 또는 MEMENTO_BACKUP_DIR. 기본값은 $XDG_STATE_HOME/memento-mcp/backups
# (없으면 $HOME/.local/state/memento-mcp/backups). 저장소 안쪽은 거부한다.
# 보관: --keep 또는 MEMENTO_BACKUP_KEEP_DAYS. 기본 14. 날짜별 가장 늦은 한 벌을 최근 N일치 남긴다.
#
# 한 벌의 파일(저장 위치에 모두 권한 600):
#   memento-<UTC 시각>.dump         pg_dump -Fc --schema=agent_memory
#   memento-<UTC 시각>.dump.sha256  sha256sum 형식
#   memento-<UTC 시각>.counts.json  덤프와 같은 스냅숏의 표별 행 수, schema_migrations 최댓값, HNSW 색인 수
#   memento-<UTC 시각>.roles.sql    pg_dumpall --roles-only --no-role-passwords
# 출력은 파일 이름, 바이트 수, 개수뿐이며 행 내용은 출력하지 않는다.
#
# 종료 코드: 0 성공, 1 실패, 2 사용법 또는 저장 위치 거부, 3 덤프는 확정됐으나 역할 정의 실패
#
# 사용:
#   PGHOST=... PGUSER=... PGDATABASE=... scripts/ops/backup.sh [--dir DIR] [--keep N] [--dry-run]
#   scripts/ops/backup.sh --host H --port P --user U --dbname D [--no-roles]

set -euo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
POLICY="$SCRIPT_DIR/backup-policy.mjs"
COUNTS_SQL="$SCRIPT_DIR/drill-counts.sql"
SCHEMA="agent_memory"

DEFAULT_KEEP=14
if [[ -n "${XDG_STATE_HOME:-}" ]]; then
  DEFAULT_DIR="$XDG_STATE_HOME/memento-mcp/backups"
elif [[ -n "${HOME:-}" ]]; then
  DEFAULT_DIR="$HOME/.local/state/memento-mcp/backups"
else
  DEFAULT_DIR=""
fi

dest="${MEMENTO_BACKUP_DIR:-$DEFAULT_DIR}"
keep="${MEMENTO_BACKUP_KEEP_DAYS:-$DEFAULT_KEEP}"
dry_run=0
with_roles=1
conn=()

usage() {
  awk '/^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

die() {
  local code="$1"; shift
  printf 'backup: %s\n' "$*" >&2
  exit "$code"
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || die 2 "$1 에 값이 필요하다"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      need_value "$@"; dest="$2"; shift 2 ;;
    --keep)     need_value "$@"; keep="$2"; shift 2 ;;
    --host)     need_value "$@"; conn+=(--host "$2"); shift 2 ;;
    --port)     need_value "$@"; conn+=(--port "$2"); shift 2 ;;
    --user)     need_value "$@"; conn+=(--username "$2"); shift 2 ;;
    --dbname)   need_value "$@"; conn+=(--dbname "$2"); dbname="$2"; shift 2 ;;
    --no-roles) with_roles=0; shift ;;
    --dry-run)  dry_run=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die 2 "알 수 없는 인자: $1" ;;
  esac
done

[[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 1 ]] || die 2 "보관 일수는 1 이상의 정수여야 한다: $keep"
[[ -n "$dest" ]] || die 2 "저장 위치를 정할 수 없다 (--dir 또는 MEMENTO_BACKUP_DIR)"

command -v node >/dev/null || die 1 "node 가 필요하다"
dest=$(node "$POLICY" guard "$dest") || die 2 "저장 위치 검사에 실패했다"

if [[ -z "${dbname:-}" && -z "${PGDATABASE:-}" ]]; then
  die 2 "데이터베이스 이름이 필요하다 (--dbname 또는 PGDATABASE)"
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mapfile -t names < <(node "$POLICY" set "$stamp")
dump_name="${names[0]}"; sha_name="${names[1]}"; counts_name="${names[2]}"; roles_name="${names[3]}"

if [[ "$dry_run" -eq 1 ]]; then
  mapfile -t expired_preview < <(node "$POLICY" expire "$dest" "$keep" "$stamp")
  printf 'backup: dry-run, 아무것도 쓰지 않고 접속하지 않는다\n'
  printf 'destination: %s\n' "$dest"
  printf 'keep days: %s\n' "$keep"
  printf 'would write: %s\n' "$dump_name" "$sha_name" "$counts_name"
  [[ "$with_roles" -eq 1 ]] && printf 'would write: %s\n' "$roles_name"
  printf 'would run: pg_dump -Fc --schema=%s --snapshot=<exported> %s\n' "$SCHEMA" "${conn[*]:-}"
  printf 'files retention would remove after writing the new set: %s\n' "${#expired_preview[@]}"
  for name in "${expired_preview[@]}"; do printf 'would remove: %s\n' "$name"; done
  exit 0
fi

for tool in pg_dump pg_restore psql sha256sum flock; do
  command -v "$tool" >/dev/null || die 1 "$tool 이 PATH 에 없다"
done
[[ "$with_roles" -eq 0 ]] || command -v pg_dumpall >/dev/null || die 1 "pg_dumpall 이 PATH 에 없다"

mkdir -p -- "$dest"
chmod 700 -- "$dest"

exec 9>"$dest/.backup.lock"
flock -n 9 || die 1 "다른 백업이 같은 저장 위치에서 실행 중이다"

partial_files=()
cleanup() {
  local file
  for file in "${partial_files[@]}"; do rm -f -- "$file"; done
  if [[ -n "${SNAP_PID:-}" ]]; then
    exec {SNAP[1]}>&- 2>/dev/null || true
    kill "$SNAP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

shopt -s nullglob
for stale in "$dest"/*.partial; do rm -f -- "$stale"; done
shopt -u nullglob

[[ ! -e "$dest/$dump_name" ]] || die 1 "같은 시각의 덤프가 이미 있다: $dump_name"

dump_part="$dest/$dump_name.partial"
counts_part="$dest/$counts_name.partial"
roles_part="$dest/$roles_name.partial"
sha_part="$dest/$sha_name.partial"
partial_files=("$dump_part" "$counts_part" "$roles_part" "$sha_part")

# 덤프와 행 수가 같은 시점을 보도록 스냅숏을 내보낸 읽기 전용 트랜잭션을 덤프가 끝날 때까지 연다.
coproc SNAP { psql "${conn[@]}" -X -q -A -t -v ON_ERROR_STOP=1; }

snap_send() {
  printf '%s\n' "$@" '\echo @@END@@' >&"${SNAP[1]}"
}

snap_read() {
  local line
  SNAP_LINES=()
  while IFS= read -r -t 120 line <&"${SNAP[0]}"; do
    [[ "$line" == "@@END@@" ]] && return 0
    SNAP_LINES+=("$line")
  done
  return 1
}

snap_send "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT 'SNAP:' || pg_export_snapshot();"
snap_read || die 1 "스냅숏을 내보내지 못했다 (접속 값과 권한을 확인한다)"
snapshot=""
for line in "${SNAP_LINES[@]}"; do
  [[ "$line" == SNAP:* ]] && snapshot="${line#SNAP:}"
done
[[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] || die 1 "스냅숏 식별자를 읽지 못했다"

snap_send "$(cat "$COUNTS_SQL")"
snap_read || die 1 "행 수 질의가 실패했다"
counts_json=""
for line in "${SNAP_LINES[@]}"; do
  [[ "$line" == "{"* ]] && counts_json="$line"
done
[[ -n "$counts_json" ]] || die 1 "행 수 질의 결과가 비어 있다"

printf '{"version":1,"createdAt":"%s","counts":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$counts_json" > "$counts_part"

pg_dump "${conn[@]}" --format=custom --schema="$SCHEMA" --snapshot="$snapshot" --file="$dump_part" \
  || die 1 "pg_dump 가 실패했다"

snap_send "COMMIT;" '\q'
exec {SNAP[1]}>&-
wait "$SNAP_PID" 2>/dev/null || true
SNAP_PID=""

toc_entries=$(pg_restore --list "$dump_part" | grep -cE '^[0-9]+;' || true)
[[ "$toc_entries" -gt 0 ]] || die 1 "덤프 목차를 읽지 못했다"

hash=$(sha256sum < "$dump_part" | cut -d' ' -f1)
printf '%s  %s\n' "$hash" "$dump_name" > "$sha_part"

roles_status=0
if [[ "$with_roles" -eq 1 ]]; then
  dump_all_args=(--roles-only --no-role-passwords)
  [[ -n "${dbname:-}" ]] && dump_all_args+=(--database "$dbname")
  host_args=()
  for ((i = 0; i < ${#conn[@]}; i += 2)); do
    [[ "${conn[i]}" == "--dbname" ]] || host_args+=("${conn[i]}" "${conn[i + 1]}")
  done
  if ! pg_dumpall "${host_args[@]}" "${dump_all_args[@]}" --file="$roles_part"; then
    roles_status=3
    rm -f -- "$roles_part"
  fi
fi

# 완결 표지는 덤프 파일의 이름 확정이다. 나머지를 먼저 확정하고 덤프를 마지막에 옮긴다.
mv -- "$counts_part" "$dest/$counts_name"
[[ ! -e "$roles_part" ]] || mv -- "$roles_part" "$dest/$roles_name"
mv -- "$sha_part" "$dest/$sha_name"
mv -- "$dump_part" "$dest/$dump_name"
partial_files=()

printf 'written: %s %s bytes\n' "$dump_name" "$(stat -c %s -- "$dest/$dump_name")"
printf 'written: %s\n' "$sha_name" "$counts_name"
[[ ! -e "$dest/$roles_name" ]] || printf 'written: %s\n' "$roles_name"
printf 'toc entries: %s\n' "$toc_entries"

if [[ "$roles_status" -ne 0 ]]; then
  die 3 "역할 정의 덤프가 실패했다. 덤프는 확정됐다. 역할 덤프가 필요 없으면 --no-roles 를 쓴다"
fi

mapfile -t expired < <(node "$POLICY" expire "$dest" "$keep")
for name in "${expired[@]}"; do
  [[ "$name" =~ ^memento-[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9.]+$ ]] || die 1 "삭제 대상 이름 형식이 아니다: $name"
  rm -f -- "$dest/$name"
  printf 'removed: %s\n' "$name"
done
printf 'removed files: %s\n' "${#expired[@]}"
