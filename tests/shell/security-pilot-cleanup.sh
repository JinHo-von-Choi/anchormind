#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$ROOT/scripts/security-pilot-cleanup.sh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/security-pilot-cleanup.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

FAKE_BIN="$TEMP_DIR/bin"
mkdir -p "$FAKE_BIN"
QUERY_LOG="$TEMP_DIR/queries.log"
DOCKER_LOG="$TEMP_DIR/docker.log"
ROWS_FILE="$TEMP_DIR/rows.tsv"

cat > "$FAKE_BIN/pg_isready" <<'FAKE_PG_ISREADY'
#!/usr/bin/env bash
printf 'pg_isready\n' >> "$FAKE_QUERY_LOG"
exit "${FAKE_READY_RC:-0}"
FAKE_PG_ISREADY

cat > "$FAKE_BIN/psql" <<'FAKE_PSQL'
#!/usr/bin/env bash
set -euo pipefail
query="$*"
printf 'psql %s\n' "$query" >> "$FAKE_QUERY_LOG"
if [[ "$query" == *"DELETE FROM agent_memory.fragments"* ]]; then
  if [[ "${FAKE_DELETE_FAIL:-0}" == "1" ]]; then exit 1; fi
  awk '$0 != "synthetic-fragment" && $0 != "synthetic-key-a" && $0 != "synthetic-key-b"' \
    "$FAKE_ROWS_FILE" > "$FAKE_ROWS_FILE.tmp"
  mv "$FAKE_ROWS_FILE.tmp" "$FAKE_ROWS_FILE"
  exit 0
fi
if [[ "$query" == *"SELECT"* ]]; then
  if [[ "${FAKE_COUNT_FAIL:-0}" == "1" ]]; then exit 1; fi
  printf '%s\n' "${FAKE_COUNT:-0}"
fi
FAKE_PSQL

cat > "$FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == *" down "* ]]; then exit "${FAKE_DOWN_RC:-0}"; fi
exit 0
FAKE_DOCKER

chmod +x "$FAKE_BIN/pg_isready" "$FAKE_BIN/psql" "$FAKE_BIN/docker"

run_cleanup() {
  local original_rc="$1"
  shift
  : > "$QUERY_LOG"
  : > "$DOCKER_LOG"
  printf '%s\n' synthetic-fragment synthetic-key-a synthetic-key-b other-fragment other-key > "$ROWS_FILE"
  env \
    HELPER="$HELPER" \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_QUERY_LOG="$QUERY_LOG" \
    FAKE_DOCKER_LOG="$DOCKER_LOG" \
    FAKE_ROWS_FILE="$ROWS_FILE" \
    "$@" \
    ORIGINAL_RC="$original_rc" \
    /bin/bash -c '
      set +e
      . "$HELPER"
      COMPOSE_ARGS=(--project-name fake -f fake.yml)
      SERVICE_ID=canonical-service
      if [[ "${CLEANUP_NO_SERVICE:-0}" == "1" ]]; then SERVICE_ID=; fi
      SYNTHETIC_TOPIC=security-pilot-synthetic
      SYNTHETIC_API_KEY_A=00000000-0000-0000-0000-00000000aaaa
      SYNTHETIC_API_KEY_B=00000000-0000-0000-0000-00000000bbbb
      run_security_pilot_pg_isready() { pg_isready >/dev/null 2>&1; }
      run_security_pilot_psql() { psql "$@"; }
      (exit "$ORIGINAL_RC")
      security_pilot_cleanup
    '
}

assert_status() {
  local expected="$1"
  shift
  set +e
  "$@"
  local actual=$?
  set -e
  if [[ "$actual" != "$expected" ]]; then
    echo "expected status $expected, got $actual" >&2
    exit 1
  fi
}

assert_file_contains() {
  local pattern="$1"
  local file="$2"
  grep -Fq "$pattern" "$file"
}

assert_file_not_contains() {
  local pattern="$1"
  local file="$2"
  if grep -Fq "$pattern" "$file"; then
    echo "unexpected '$pattern' in $file" >&2
    exit 1
  fi
}

assert_status 7 run_cleanup 7
assert_file_contains "DELETE FROM agent_memory.fragments WHERE topic = 'security-pilot-synthetic'" "$QUERY_LOG"
assert_file_contains "00000000-0000-0000-0000-00000000aaaa" "$QUERY_LOG"
assert_file_contains "00000000-0000-0000-0000-00000000bbbb" "$QUERY_LOG"
assert_file_contains "SELECT" "$QUERY_LOG"
assert_file_not_contains "DELETE FROM agent_memory.fragments WHERE topic = 'other'" "$QUERY_LOG"
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"
assert_file_not_contains " -v" "$DOCKER_LOG"

assert_status 1 run_cleanup 0 FAKE_DELETE_FAIL=1
assert_file_contains "SELECT" "$QUERY_LOG"
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"

assert_status 7 run_cleanup 7 FAKE_DELETE_FAIL=1
assert_file_contains "SELECT" "$QUERY_LOG"
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"

assert_status 1 run_cleanup 0 FAKE_COUNT=2
assert_file_contains "SELECT" "$QUERY_LOG"
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"

assert_status 7 run_cleanup 7 FAKE_COUNT_FAIL=1
assert_file_contains "SELECT" "$QUERY_LOG"
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"

assert_status 7 run_cleanup 7 FAKE_DOWN_RC=1
assert_status 1 run_cleanup 0 FAKE_DOWN_RC=1

assert_status 0 run_cleanup 0 CLEANUP_NO_SERVICE=1
if [[ -s "$QUERY_LOG" ]]; then
  echo "SQL query executed without canonical service" >&2
  exit 1
fi
assert_file_contains "other-fragment" "$ROWS_FILE"
assert_file_contains "other-key" "$ROWS_FILE"
assert_file_not_contains " -v" "$DOCKER_LOG"

echo "security-pilot-cleanup shell tests: PASS"
