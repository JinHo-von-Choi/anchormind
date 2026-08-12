#!/usr/bin/env bash
#
# Memento MCP (AnchorMind) 헬스체크 및 자가 복구 와치독 스크립트
#
# 작성자: 최진호 / 작성일: 2026-08-07

HEALTH_URL="http://127.0.0.1:57332/health"
STARTUP_GRACE_SEC=120

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
    # 기동 유예: 서비스가 방금 시작됐으면 부팅(모델 로드 등)이 끝나기 전에 죽이지 않는다.
    # 유예 없이는 부팅이 1분을 넘는 순간 매분 킬 → 재부팅 → 킬의 재시작 폭풍이 된다.
    STARTED_AT=$(systemctl show memento-mcp.service -p ActiveEnterTimestamp --value 2>/dev/null)
    if [ -n "$STARTED_AT" ]; then
        STARTED_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
        AGE=$(( $(date +%s) - STARTED_EPOCH ))
        if [ "$STARTED_EPOCH" -gt 0 ] && [ "$AGE" -lt "$STARTUP_GRACE_SEC" ]; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] 기동 ${AGE}초 경과 (유예 ${STARTUP_GRACE_SEC}초 미만) — 재시작 보류"
            exit 0
        fi
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ Memento MCP 이상 감지 (HTTP $HTTP_CODE). 재시작 수행..."
    sudo systemctl restart memento-mcp.service
    sleep 3
    RECHECK_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
    if [ "$RECHECK_CODE" = "200" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Memento MCP 자가 복구 성공"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🚨 Memento MCP 자가 복구 실패 (HTTP $RECHECK_CODE)"
    fi
fi
