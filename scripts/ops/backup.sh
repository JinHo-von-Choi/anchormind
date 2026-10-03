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
# (없으면 $HOME/.local/state/memento-mcp/backups). 저장소 안쪽, 파일 시스템 루트, 홈 디렉터리
# 자체는 거부한다. 스크립트가 만든 디렉터리만 권한 700이고, 이미 있는 디렉터리의 권한은
# 바꾸지 않는다. 이미 있는 디렉터리를 그룹이나 다른 사용자가 접근할 수 있으면 거부하며
# --allow-open-dir 로 허용한다. 저장 위치의 다른 파일은 지우지 않는다.
# 보관: --keep 또는 MEMENTO_BACKUP_KEEP_DAYS. 기본 14. 날짜별 가장 늦은 한 벌을 최근 N일치 남긴다.
# 이번 실행이 쓴 벌과 그보다 늦은 시각의 벌은 보관 정리에서 지우지 않는다. 관리 대상 이름이
# 심볼릭 링크이거나 쓸 이름이 이미 있으면 아무것도 쓰거나 지우지 않고 멈춘다(종료 코드 2).
# 라벨: --label NAME([a-z0-9-] 1자 이상 32자 이하)을 주면 이름이 memento-<시각>-NAME 이 되고
# 보관 일수 정리에서 제외된다. 라벨 벌은 --prune-labelled DAYS 로만 지워진다(기본은 지우지 않음).
#
# 한 벌의 파일(저장 위치에 모두 권한 600):
#   memento-<UTC 시각>[-<라벨>].dump         pg_dump -Fc --schema=agent_memory
#   memento-<UTC 시각>[-<라벨>].dump.sha256  sha256sum 형식
#   memento-<UTC 시각>[-<라벨>].counts.json  덤프와 같은 스냅숏의 표별 행 수, schema_migrations 최댓값, HNSW 색인 수
#   memento-<UTC 시각>[-<라벨>].roles.sql    pg_dumpall --roles-only --no-role-passwords
# 출력은 파일 이름, 바이트 수, 개수뿐이며 행 내용은 출력하지 않는다.
#
# 종료 코드: 0 성공, 1 실패, 2 사용법 또는 저장 위치 거부, 3 덤프는 확정됐으나 역할 정의 실패
#
# 사용:
#   PGHOST=... PGUSER=... PGDATABASE=... scripts/ops/backup.sh [--dir DIR] [--keep N] [--dry-run]
#   scripts/ops/backup.sh --host H --port P --user U --dbname D [--no-roles]
#   scripts/ops/backup.sh --label pre-migration

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
allow_open=0
label=""
prune_days=""
dbname=""
snapshot=""
roles_status=0
SNAP_PID=""
partial_files=()
conn=()

usage() {
  awk '/^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

die() {
  local code="$1"; shift
  printf 'backup: %s\n' "$*" >&2
  exit "$code"
}

# 값이 필요한 옵션: 값이 없거나 비었거나 다른 옵션처럼 보이면(--로 시작) 거부한다.
need_value() {
  [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die 2 "$1 에 값이 필요하다 (비어 있거나 다른 옵션으로 시작하는 값은 받지 않는다)"
}

# 접속 문자열(conninfo, URI)은 비밀번호가 프로세스 목록과 출력에 드러나므로 받지 않는다.
check_dbname() {
  local lowered="${1,,}"
  if [[ "$lowered" == *"://"* || "$lowered" =~ password[[:space:]]*= ]]; then
    die 2 "데이터베이스 이름에 접속 문자열을 쓸 수 없다. 비밀번호는 PGPASSFILE 또는 PGPASSWORD 로 준다"
  fi
}

# 정책 계산(node)을 실행하고 출력 줄을 POLICY_LINES 에 담는다. 실패하면 멈춘다.
policy_lines() {
  local out
  local status=0
  out=$(node "$POLICY" "$@") || status=$?
  if [[ "$status" -ne 0 ]]; then
    [[ "$status" -eq 2 ]] && die 2 "정책 검사가 진행을 거부했다: $1"
    die 1 "정책 계산이 실패했다: $1"
  fi
  POLICY_LINES=()
  if [[ -n "$out" ]]; then mapfile -t POLICY_LINES <<< "$out"; fi
}

# 이미 있는 저장 위치는 권한을 바꾸지 않고 검사만 한다.
check_existing_dest() {
  [[ -e "$dest" ]] || return 0
  [[ -d "$dest" ]] || die 2 "저장 위치가 디렉터리가 아니다: $dest"
  local mode
  mode=$(stat -c %a -- "$dest")
  if (( (8#$mode & 8#077) != 0 )) && [[ "$allow_open" -eq 0 ]]; then
    die 2 "기존 저장 위치 $dest 의 권한이 $mode 이라 그룹이나 다른 사용자가 접근할 수 있다. 스크립트는 기존 디렉터리의 권한을 바꾸지 않는다. 직접 바꾸거나 --allow-open-dir 을 준다"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      need_value "$@"; dest="$2"; shift 2 ;;
    --keep)     need_value "$@"; keep="$2"; shift 2 ;;
    --host)     need_value "$@"; conn+=(--host "$2"); shift 2 ;;
    --port)     need_value "$@"; conn+=(--port "$2"); shift 2 ;;
    --user)     need_value "$@"; conn+=(--username "$2"); shift 2 ;;
    --dbname)   need_value "$@"; check_dbname "$2"; conn+=(--dbname "$2"); dbname="$2"; shift 2 ;;
    --label)    need_value "$@"; label="$2"; shift 2 ;;
    --prune-labelled) need_value "$@"; prune_days="$2"; shift 2 ;;
    --allow-open-dir) allow_open=1; shift ;;
    --no-roles) with_roles=0; shift ;;
    --dry-run)  dry_run=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die 2 "알 수 없는 인자: $1" ;;
  esac
done

[[ "$keep" =~ ^[1-9][0-9]{0,3}$ ]] || die 2 "보관 일수는 앞에 0이 없는 1 이상 9999 이하의 정수여야 한다: $keep"
[[ -n "$dest" ]] || die 2 "저장 위치를 정할 수 없다 (--dir 또는 MEMENTO_BACKUP_DIR)"
[[ -z "$label" || "$label" =~ ^[a-z0-9-]{1,32}$ ]] || die 2 "라벨은 [a-z0-9-] 1자 이상 32자 이하여야 한다: $label"
[[ -z "$prune_days" || "$prune_days" =~ ^[1-9][0-9]{0,3}$ ]] || die 2 "--prune-labelled 는 앞에 0이 없는 1 이상 9999 이하의 정수여야 한다: $prune_days"

command -v node >/dev/null || die 1 "node 가 필요하다"
dest=$(node "$POLICY" guard "$dest") || die 2 "저장 위치 검사에 실패했다"
check_existing_dest

if [[ -z "$dbname" && -z "${PGDATABASE:-}" ]]; then
  die 2 "데이터베이스 이름이 필요하다 (--dbname 또는 PGDATABASE)"
fi
[[ -z "${PGDATABASE:-}" ]] || check_dbname "$PGDATABASE"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
policy_lines set "$stamp" ${label:+"$label"}
dump_name="${POLICY_LINES[0]}"; sha_name="${POLICY_LINES[1]}"; counts_name="${POLICY_LINES[2]}"; roles_name="${POLICY_LINES[3]}"

expire_args=(expire "$dest" "$keep" --with "$stamp${label:+:$label}")
[[ -z "$prune_days" ]] || expire_args+=(--prune-labelled "$prune_days")

if [[ "$dry_run" -eq 1 ]]; then
  policy_lines "${expire_args[@]}"
  expired_preview=("${POLICY_LINES[@]}")
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

# 새로 만드는 디렉터리는 umask 077 에 따라 700 이다. 이미 있는 디렉터리의 권한은 건드리지 않는다.
mkdir -p -m 700 -- "$dest"

# 잠금은 저장 위치 디렉터리 자체에 건다. 잠금 파일을 만들지 않으므로 심볼릭 링크를 따라가 쓸 일이 없다.
exec 9< "$dest"
flock -n 9 || die 1 "다른 백업이 같은 저장 위치에서 실행 중이다"

# 이후 리다이렉션은 이미 있는 파일을 덮어쓰지 않는다.
set -C

# 쓸 경로가 이미 있거나 심볼릭 링크이면 거부한다.
refuse_existing() {
  local path
  for path in "$@"; do
    if [[ -e "$path" || -L "$path" ]]; then
      die 2 "쓸 경로가 이미 있거나 심볼릭 링크라 진행하지 않는다: ${path##*/}"
    fi
  done
}

# 이름 없는 빈 파일을 배타적으로 만든다(이미 있으면 실패한다).
create_exclusive() {
  refuse_existing "$1"
  : > "$1" || die 2 "파일을 만들지 못했다: ${1##*/}"
}

cleanup() {
  local file
  for file in "${partial_files[@]}"; do rm -f -- "$file"; done
  if [[ -n "${SNAP_PID:-}" ]]; then
    exec {SNAP[1]}>&- 2>/dev/null || true
    kill "$SNAP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 이 스크립트가 남긴 미확정 파일만 지운다. 이름을 한 번 더 검사하고 일반 파일만 지운다.
policy_lines partials "$dest"
for stale in "${POLICY_LINES[@]}"; do
  [[ "$stale" =~ ^memento-[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,32})?\.(dump\.sha256|dump|counts\.json|roles\.sql)\.partial$ ]] \
    || die 1 "미확정 파일 이름 형식이 아니다: $stale"
  if [[ -f "$dest/$stale" && ! -L "$dest/$stale" ]]; then rm -f -- "$dest/$stale"; fi
done

[[ ! -e "$dest/$dump_name" ]] || die 1 "같은 시각의 덤프가 이미 있다: $dump_name"
refuse_existing "$dest/$dump_name" "$dest/$sha_name" "$dest/$counts_name" "$dest/$roles_name"

dump_part="$dest/$dump_name.partial"
counts_part="$dest/$counts_name.partial"
roles_part="$dest/$roles_name.partial"
sha_part="$dest/$sha_name.partial"
refuse_existing "$dump_part" "$counts_part" "$roles_part" "$sha_part"
partial_files=("$dump_part" "$counts_part" "$roles_part" "$sha_part")
create_exclusive "$dump_part"
[[ "$with_roles" -eq 0 ]] || create_exclusive "$roles_part"

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

# COMMIT 의 응답을 받은 뒤 입력을 닫아 psql 이 스스로 끝나게 한다. psql 이 끝난 뒤에는 쓰지 않는다.
snap_send "COMMIT;"
snap_read || true
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
  [[ -z "$dbname" ]] || dump_all_args+=(--database "$dbname")
  host_args=()
  for ((i = 0; i < ${#conn[@]}; i += 2)); do
    [[ "${conn[i]}" == "--dbname" ]] || host_args+=("${conn[i]}" "${conn[i + 1]}")
  done
  if ! pg_dumpall "${host_args[@]}" "${dump_all_args[@]}" --file="$roles_part"; then
    roles_status=3
    rm -f -- "$roles_part"
  fi
fi

# 이름을 확정하기 전에 내용을 디스크에 내린다. sync 가 없으면 건너뛴다.
sync_paths() {
  command -v sync >/dev/null || return 0
  sync -- "$@" 2>/dev/null || sync
}
sync_paths "$dump_part" "$counts_part" "$sha_part"
[[ ! -e "$roles_part" ]] || sync_paths "$roles_part"

# 완결 표지는 덤프 파일의 이름 확정이다. 나머지를 먼저 확정하고 덤프를 마지막에 옮긴다.
commit_file() {
  refuse_existing "$2"
  mv -T -- "$1" "$2"
}
commit_file "$counts_part" "$dest/$counts_name"
[[ ! -e "$roles_part" ]] || commit_file "$roles_part" "$dest/$roles_name"
commit_file "$sha_part" "$dest/$sha_name"
commit_file "$dump_part" "$dest/$dump_name"
partial_files=()
sync_paths "$dest"

printf 'written: %s %s bytes\n' "$dump_name" "$(stat -c %s -- "$dest/$dump_name")"
printf 'written: %s\n' "$sha_name" "$counts_name"
[[ ! -e "$dest/$roles_name" ]] || printf 'written: %s\n' "$roles_name"
printf 'toc entries: %s\n' "$toc_entries"

if [[ "$roles_status" -ne 0 ]]; then
  die 3 "역할 정의 덤프가 실패했다. 덤프는 확정됐다. 역할 덤프가 필요 없으면 --no-roles 를 쓴다"
fi

# 드라이런과 같은 계획 함수를 같은 입력(이번 실행이 쓴 벌)으로 부른다. 그 벌은 삭제에서 보호된다.
policy_lines "${expire_args[@]}"
expired=("${POLICY_LINES[@]}")
for name in "${expired[@]}"; do
  [[ "$name" =~ ^memento-[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,32})?\.(dump\.sha256|dump|counts\.json|roles\.sql)$ ]] || die 1 "삭제 대상 이름 형식이 아니다: $name"
  rm -f -- "$dest/$name"
  printf 'removed: %s\n' "$name"
done
printf 'removed files: %s\n' "${#expired[@]}"
