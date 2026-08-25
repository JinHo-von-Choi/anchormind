#!/usr/bin/env bash

security_pilot_delete_synthetic_rows() {
  run_security_pilot_psql -v ON_ERROR_STOP=1 -c \
    "DELETE FROM agent_memory.fragments WHERE topic = '$SYNTHETIC_TOPIC';
     DELETE FROM agent_memory.api_keys WHERE id IN ('$SYNTHETIC_API_KEY_A', '$SYNTHETIC_API_KEY_B');" >/dev/null
}

security_pilot_verify_synthetic_rows_removed() {
  local remaining
  if ! remaining="$(run_security_pilot_psql -Atqc "SELECT
    (SELECT count(*) FROM agent_memory.fragments WHERE topic = '$SYNTHETIC_TOPIC') +
    (SELECT count(*) FROM agent_memory.api_keys WHERE id IN ('$SYNTHETIC_API_KEY_A', '$SYNTHETIC_API_KEY_B'))")"; then
    return 1
  fi
  if ! test "$remaining" = 0; then
    return 1
  fi
}

security_pilot_cleanup() {
  local rc=$?
  set +e
  if [[ -n "${SERVICE_ID:-}" ]] && declare -F run_security_pilot_pg_isready >/dev/null 2>&1; then
    if run_security_pilot_pg_isready >/dev/null 2>&1; then
      if ! security_pilot_delete_synthetic_rows; then
        echo "WARN: synthetic fixture cleanup failed before teardown" >&2
        if (( rc == 0 )); then rc=1; fi
      fi
      if ! security_pilot_verify_synthetic_rows_removed; then
        echo "WARN: synthetic fixture cleanup remaining-count readback failed before teardown" >&2
        if (( rc == 0 )); then rc=1; fi
      fi
    else
      echo "WARN: UNRESOLVED: canonical PostgreSQL service failed pg_isready; synthetic cleanup readback was skipped before teardown" >&2
      if (( rc == 0 )); then rc=1; fi
    fi
  fi
  docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans >/tmp/anchormind-security-pilot-down.log 2>&1
  local down_rc=$?
  if (( down_rc != 0 )); then
    echo "WARN: dedicated compose teardown failed; see /tmp/anchormind-security-pilot-down.log" >&2
    if (( rc == 0 )); then rc=1; fi
  fi
  exit "$rc"
}
