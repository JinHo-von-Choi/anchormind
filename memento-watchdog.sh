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
# 작성자: 최진호 / 작성일: 2026-08-07 / 수정일: 2026-10-03

BASE_URL="${MEMENTO_WATCHDOG_BASE_URL:-http://127.0.0.1:57332}"
SERVICE="${MEMENTO_WATCHDOG_SERVICE:-memento-mcp.service}"
STATE_FILE="${MEMENTO_WATCHDOG_STATE_FILE:-/tmp/memento-watchdog.state}"
STARTUP_GRACE_SEC="${MEMENTO_WATCHDOG_STARTUP_GRACE_SEC:-120}"
BACKOFF_BASE_SEC="${MEMENTO_WATCHDOG_BACKOFF_BASE_SEC:-60}"
BACKOFF_MAX_SEC="${MEMENTO_WATCHDOG_BACKOFF_MAX_SEC:-1800}"
NOW="${MEMENTO_WATCHDOG_NOW:-$(date +%s)}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# 상태 코드만 출력한다. 연결 실패와 시간 초과는 000이다.
http_code() {
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null)
    echo "${code:-000}"
}

service_age_sec() {
    if [ -n "${MEMENTO_WATCHDOG_SERVICE_AGE_SEC:-}" ]; then
        echo "$MEMENTO_WATCHDOG_SERVICE_AGE_SEC"
        return
    fi
    local started epoch
    started=$(systemctl show "$SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null)
    epoch=$(date -d "$started" +%s 2>/dev/null || echo 0)
    if [ "$epoch" -gt 0 ]; then echo $(( NOW - epoch )); else echo 999999; fi
}

restart_service() {
    if [ -n "${MEMENTO_WATCHDOG_RESTART_CMD:-}" ]; then
        eval "$MEMENTO_WATCHDOG_RESTART_CMD"
    else
        sudo systemctl restart "$SERVICE"
    fi
}

# 상태 파일: "연속재시작횟수 마지막재시작epoch 마지막ready코드"
if [ -f "$STATE_FILE" ]; then read -r RESTARTS LAST_RESTART LAST_READY < "$STATE_FILE"; fi
RESTARTS="${RESTARTS:-0}"; LAST_RESTART="${LAST_RESTART:-0}"; LAST_READY="${LAST_READY:-none}"

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
    echo "0 $LAST_RESTART $READY_CODE" > "$STATE_FILE"
    exit 0
fi

AGE=$(service_age_sec)
if [ "$AGE" -lt "$STARTUP_GRACE_SEC" ]; then
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
    if [ "$SINCE" -lt "$WAIT" ]; then
        log "live=$LIVE_CODE, 연속 재시작 ${RESTARTS}회, 대기 ${SINCE}/${WAIT}초, 재시작 보류"
        exit 0
    fi
fi

log "live=$LIVE_CODE, 재시작 수행 (연속 $(( RESTARTS + 1 ))회째)"
restart_service
echo "$(( RESTARTS + 1 )) $NOW $LAST_READY" > "$STATE_FILE"
