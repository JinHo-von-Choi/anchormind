#!/usr/bin/env bash
#
# Memento MCP (AnchorMind) 와치독
#
# 매분 cron이 실행한다. 프로세스가 응답하지 않을 때(연결 실패, 시간 초과,
# /health/live 200 아님)만 서비스를 재시작한다. DB 등 의존 서비스 상태는
# /health/ready로 보고 기록만 한다. 연속 재시작은 지수 간격으로 늦춘다.
#
# /health/live가 없는 서버(404)는 /health로 판정하되, 응답이 오면(200, 503)
# 살아 있는 것으로 본다.
#
# 동시에 둘 이상 돌지 않도록 잠금 파일을 쓰고, 재시작 이력은 재시작 명령을
# 부르기 전에 임시 파일과 mv로 기록한다. 상태 파일이 손상됐거나 기록할 수
# 없으면 정상 상태보다 재시작이 늘지 않도록 대기 구간부터 다시 시작하거나
# 재시작을 보류한다.
#
# 작성자: 최진호 / 작성일: 2026-08-07 / 수정일: 2026-10-03

BASE_URL="${MEMENTO_WATCHDOG_BASE_URL:-http://127.0.0.1:57332}"
SERVICE="${MEMENTO_WATCHDOG_SERVICE:-memento-mcp.service}"
STATE_FILE="${MEMENTO_WATCHDOG_STATE_FILE:-/tmp/memento-watchdog.state}"
STARTUP_GRACE_SEC="${MEMENTO_WATCHDOG_STARTUP_GRACE_SEC:-120}"
BACKOFF_BASE_SEC="${MEMENTO_WATCHDOG_BACKOFF_BASE_SEC:-60}"
BACKOFF_MAX_SEC="${MEMENTO_WATCHDOG_BACKOFF_MAX_SEC:-1800}"
LOCK_FILE="${MEMENTO_WATCHDOG_LOCK_FILE:-${STATE_FILE}.lock}"
NOW="${MEMENTO_WATCHDOG_NOW:-$(date +%s)}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 상태 코드만 출력한다. 연결 실패와 시간 초과는 000이다.
http_code() {
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null)
    echo "${code:-000}"
}

# 기동 후 경과 초. 시각을 알 수 없으면 아주 큰 값(유예 아님)을 돌려준다.
service_age_sec() {
    if [ -n "${MEMENTO_WATCHDOG_SERVICE_AGE_SEC:-}" ]; then
        echo "$MEMENTO_WATCHDOG_SERVICE_AGE_SEC"
        return
    fi
    local started epoch
    if [ -n "${MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP+x}" ]; then
        started="$MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP"
    else
        started=$(systemctl show "$SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null)
    fi
    if [ -z "$started" ]; then echo 999999; return; fi
    epoch=$(date -d "$started" +%s 2>/dev/null || echo 0)
    if [ "$epoch" -gt 0 ]; then echo $(( NOW - epoch )); else echo 999999; fi
}

# 상태 파일을 임시 파일과 mv로 기록한다. 실패하면 1.
write_state() {
    local tmp
    tmp=$(mktemp "${STATE_FILE}.XXXXXX" 2>/dev/null) || return 1
    if echo "$1 $2 $3" > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATE_FILE" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null
    return 1
}

restart_service() {
    if [ -n "${MEMENTO_WATCHDOG_RESTART_CMD:-}" ]; then
        eval "$MEMENTO_WATCHDOG_RESTART_CMD"
    else
        sudo systemctl restart "$SERVICE"
    fi
}

mkdir -p "$(dirname "$STATE_FILE")" "$(dirname "$LOCK_FILE")" 2>/dev/null

# 이미 실행 중인 와치독이 있으면 조용히 끝낸다.
if command -v flock >/dev/null 2>&1 && { exec 9>"$LOCK_FILE"; } 2>/dev/null; then
    flock -n 9 || exit 0
fi

# 상태 파일: "연속재시작횟수 마지막재시작epoch 마지막ready코드"
# 없으면 이력 없음. 있는데 읽을 수 없거나 형식이 틀리면 방금 재시작한 것으로 보고
# 대기 구간 1회부터 시작한다.
RESTARTS=0; LAST_RESTART=0; LAST_READY=none; STATE_CORRUPT=0
if [ -e "$STATE_FILE" ]; then
    S_RESTARTS=""; S_LAST=""; S_READY=""; S_EXTRA=""
    if [ -r "$STATE_FILE" ]; then read -r S_RESTARTS S_LAST S_READY S_EXTRA < "$STATE_FILE"; fi
    if [[ "$S_RESTARTS" =~ ^[0-9]{1,9}$ ]] && [[ "$S_LAST" =~ ^[0-9]{1,12}$ ]] \
        && [[ "$S_READY" =~ ^(none|[0-9]{3})$ ]] && [ -z "$S_EXTRA" ]; then
        RESTARTS=$(( 10#$S_RESTARTS )); LAST_RESTART=$(( 10#$S_LAST )); LAST_READY="$S_READY"
    else
        RESTARTS=1; LAST_RESTART="$NOW"; STATE_CORRUPT=1
    fi
fi

LIVE_CODE=$(http_code "$BASE_URL/health/live")
ALIVE=0
if [ "$LIVE_CODE" = "200" ]; then
    ALIVE=1
elif [ "$LIVE_CODE" = "404" ]; then
    LEGACY_CODE=$(http_code "$BASE_URL/health")
    if [ "$LEGACY_CODE" != "000" ]; then ALIVE=1; fi
fi

if [ "$ALIVE" = "1" ]; then
    READY_CODE=$(http_code "$BASE_URL/health/ready")
    if [ "$READY_CODE" != "$LAST_READY" ]; then
        log "ready 상태 변화: $LAST_READY -> $READY_CODE"
    fi
    write_state 0 "$LAST_RESTART" "$READY_CODE" || log "상태 파일 기록 실패: $STATE_FILE"
    exit 0
fi

AGE=$(service_age_sec)
if [ "$AGE" -ge 0 ] && [ "$AGE" -lt "$STARTUP_GRACE_SEC" ]; then
    log "기동 ${AGE}초 경과 (유예 ${STARTUP_GRACE_SEC}초 미만), live=$LIVE_CODE, 재시작 보류"
    exit 0
fi

# 연속 재시작 n회째의 대기: BASE * 2^(n-1), 상한 MAX
if [ "$RESTARTS" -gt 0 ]; then
    WAIT=$BACKOFF_BASE_SEC
    i=1
    while [ "$i" -lt "$RESTARTS" ] && [ "$WAIT" -lt "$BACKOFF_MAX_SEC" ]; do WAIT=$(( WAIT * 2 )); i=$(( i + 1 )); done
    [ "$WAIT" -gt "$BACKOFF_MAX_SEC" ] && WAIT=$BACKOFF_MAX_SEC
    SINCE=$(( NOW - LAST_RESTART ))
    if [ "$SINCE" -ge 0 ] && [ "$SINCE" -lt "$WAIT" ]; then
        if [ "$STATE_CORRUPT" = "1" ]; then
            write_state "$RESTARTS" "$LAST_RESTART" "$LAST_READY" || log "상태 파일 기록 실패: $STATE_FILE"
            log "상태 파일 손상, 재시작 이력을 새로 시작"
        fi
        log "live=$LIVE_CODE, 연속 재시작 ${RESTARTS}회, 대기 ${SINCE}/${WAIT}초, 재시작 보류"
        exit 0
    fi
fi

# 이력을 먼저 기록한다. 기록할 수 없으면 간격을 지킬 수 없으므로 재시작하지 않는다.
if ! write_state "$(( RESTARTS + 1 ))" "$NOW" "$LAST_READY"; then
    log "live=$LIVE_CODE, 상태 파일 기록 실패($STATE_FILE), 재시작 보류"
    exit 0
fi
log "live=$LIVE_CODE, 재시작 수행 (연속 $(( RESTARTS + 1 ))회째)"
restart_service
