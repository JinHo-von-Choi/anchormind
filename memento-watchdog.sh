#!/usr/bin/env bash
#
# Memento MCP (AnchorMind) 헬스체크 및 자가 복구 와치독 스크립트
#
# 작성자: 최진호 / 작성일: 2026-08-07

HEALTH_URL="http://127.0.0.1:57332/health"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
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
