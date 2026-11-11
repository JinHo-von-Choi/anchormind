#!/usr/bin/env bash
# smoke-test-symbolic.sh — v2.8.0 Symbolic Memory end-to-end smoke 검증
#
# 작성자: 최진호
# 작성일: 2026-04-16
# 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
#
# 목적: v2.8.0 Symbolic Memory의 hard gate, validation_warnings, recall explanations,
#       /metrics 노출을 HTTP/DB 레벨에서 end-to-end 검증한다.
# 호출 조건: MEMENTO_SYMBOLIC_* 플래그 전환 후 기능 동작 확인
# 빈도: 조건부 (Symbolic 플래그 변경 시)
# 의존: .env, 실행 중인 서버(PORT), PostgreSQL, python3
# 관련 문서: docs/operations/symbolic-hard-gate.md, docs/operations/maintenance.md
#
# 사전 조건:
#   - .env 파일이 프로젝트 루트에 존재
#   - 서버가 $PORT (기본 57332) 로 실행 중
#   - MEMENTO_SYMBOLIC_* 플래그 전부 true
#
# 종료 코드:
#   0 = 전체 PASS
#   1 = 하나 이상 FAIL

set -uo pipefail

# 스크립트 루트를 프로젝트 루트로 이동
cd "$(dirname "$0")/.."

# 환경변수 로드
if [ ! -f .env ]; then
  echo "ERROR: .env 파일이 없습니다 (프로젝트 루트 기준)" >&2
  exit 1
fi

# .env 파싱 — export로 자식 프로세스(node 포함)에 전달
# xargs -d '\n' : 줄 단위 처리 (공백 보존)
# shellcheck disable=SC2046
export $(grep -v '^\s*#' .env | grep '=' | xargs -d '\n') 2>/dev/null || true

ACCESS_KEY="${MEMENTO_ACCESS_KEY}"
BASE_URL="http://localhost:${PORT:-57332}"
export PGPASSWORD="${POSTGRES_PASSWORD}"
PSQL_CMD="psql -h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${POSTGRES_USER} -d ${POSTGRES_DB} -t -A -c"

pass=0
fail=0

say()   { printf "\n=== %s ===\n" "$1"; }
check() {
  local label="$1"
  local cond="$2"
  if [ "$cond" = "1" ] || [ "$cond" = "true" ]; then
    printf "  PASS: %s\n" "$label"
    pass=$((pass+1))
  else
    printf "  FAIL: %s\n" "$label"
    fail=$((fail+1))
  fi
}

# ─── 정리용 전역 변수 ─────────────────────────────────────────────
GOOD_ID=""
BAD_ID=""
HG_API_KEY_ID=""

cleanup() {
  say "9. 정리: 테스트 데이터 삭제"
  # hard gate 테스트 키 + 파편 삭제
  if [ -n "$HG_API_KEY_ID" ]; then
    $PSQL_CMD "DELETE FROM agent_memory.fragments WHERE key_id='${HG_API_KEY_ID}';" > /dev/null 2>&1 || true
    $PSQL_CMD "DELETE FROM agent_memory.api_keys WHERE id='${HG_API_KEY_ID}';"      > /dev/null 2>&1 || true
    printf "  cleaned api_key id=%s\n" "$HG_API_KEY_ID"
  fi
  # smoke 세션 파편 삭제
  if [ -n "$GOOD_ID" ]; then
    mcp_call "{\"jsonrpc\":\"2.0\",\"id\":90,\"method\":\"tools/call\",\"params\":{\"name\":\"forget\",\"arguments\":{\"agentId\":\"smoke\",\"id\":\"$GOOD_ID\"}}}" \
      "$ACCESS_KEY" "$SESSION" > /dev/null 2>&1 || true
    printf "  cleaned fragment id=%s\n" "$GOOD_ID"
  fi
  if [ -n "$BAD_ID" ]; then
    mcp_call "{\"jsonrpc\":\"2.0\",\"id\":91,\"method\":\"tools/call\",\"params\":{\"name\":\"forget\",\"arguments\":{\"agentId\":\"smoke\",\"id\":\"$BAD_ID\"}}}" \
      "$ACCESS_KEY" "$SESSION" > /dev/null 2>&1 || true
    printf "  cleaned fragment id=%s\n" "$BAD_ID"
  fi
  printf "\n=== Summary: %d PASS / %d FAIL ===\n" "$pass" "$fail"
}

trap cleanup EXIT

# helper: MCP tools/call
# usage: mcp_call <json_body> [auth_key] [session_id]
mcp_call() {
  curl -s -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer ${2:-$ACCESS_KEY}" \
    -H "MCP-Session-Id: ${3:-$SESSION}" \
    -d "$1"
}

SESSION=""  # initialize early so cleanup trap has it

# ─── Case 1: Session 초기화 ──────────────────────────────────────────
say "1. Initialize session"
INIT_HDR=$(mktemp)
curl -s -D "$INIT_HDR" -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  > /dev/null
SESSION=$(grep -i "^mcp-session-id:" "$INIT_HDR" | awk '{print $2}' | tr -d '\r')
rm -f "$INIT_HDR"
printf "  session: %s\n" "$SESSION"
check "session id 획득" "$([ -n "$SESSION" ] && echo 1 || echo 0)"

# ─── Case 2: good decision remember ─────────────────────────────────
say "2. remember good decision (rationale 있음) — validation_warnings 없어야"
GOOD_RAW=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remember","arguments":{"agentId":"smoke","type":"decision","content":"스모크 테스트에는 curl을 쓴다. 이유: 별도 의존성 없이 즉시 실행 가능하고 CI 환경에서도 동작함.","importance":0.6,"keywords":["smoke","curl","test"],"topic":"smoke-test"}}}')
GOOD_TEXT=$(echo "$GOOD_RAW" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['content'][0]['text'])" 2>/dev/null || echo "{}")
GOOD_ID=$(echo   "$GOOD_TEXT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))"                    2>/dev/null || echo "")
GOOD_WARN=$(echo "$GOOD_TEXT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('validation_warnings',[])))" 2>/dev/null || echo "-1")
printf "  id=%s  warnings_count=%s\n" "$GOOD_ID" "$GOOD_WARN"
check "good decision 저장 성공"              "$([ -n "$GOOD_ID" ] && echo 1 || echo 0)"
check "good decision에 validation_warnings 없음" "$([ "$GOOD_WARN" = "0" ] && echo 1 || echo 0)"

# ─── Case 3: bad decision remember (soft gate) ───────────────────────
say "3. remember bad decision (rationale 없음) — validation_warnings 포함"
BAD_RAW=$(mcp_call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{"agentId":"smoke","type":"decision","content":"일단 이거로 한다","importance":0.5,"keywords":["smoke","bad"],"topic":"smoke-test"}}}')
BAD_TEXT=$(echo "$BAD_RAW" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['content'][0]['text'])" 2>/dev/null || echo "{}")
BAD_ID=$(echo   "$BAD_TEXT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))"                   2>/dev/null || echo "")
BAD_WARN=$(echo "$BAD_TEXT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d.get('validation_warnings',[])))" 2>/dev/null || echo "")
printf "  id=%s  warnings=%s\n" "$BAD_ID" "$BAD_WARN"
check "bad decision 저장됨 (soft gate 통과)"      "$([ -n "$BAD_ID" ] && echo 1 || echo 0)"
check "validation_warnings에 decisionHasRationale 포함" "$(echo "$BAD_WARN" | grep -q "decisionHasRationale" && echo 1 || echo 0)"

# ─── Case 4: DB 영속화 확인 ─────────────────────────────────────────
say "4. DB 확인: fragments.validation_warnings 컬럼 영속화"
if [ -n "$BAD_ID" ]; then
  DB_VAL=$($PSQL_CMD "SELECT validation_warnings FROM agent_memory.fragments WHERE id='${BAD_ID}';" 2>/dev/null || echo "")
  printf "  DB value: %s\n" "$DB_VAL"
  check "DB에 validation_warnings 저장됨" "$(echo "$DB_VAL" | grep -q "decisionHasRationale" && echo 1 || echo 0)"
else
  printf "  SKIP: BAD_ID 없음 — Case 3 저장 실패\n"
  fail=$((fail+1))
fi

# ─── Case 5: recall explanations 필드 확인 ──────────────────────────
say "5. recall — explanations 필드 확인"
REC_RAW=$(mcp_call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall","arguments":{"agentId":"smoke","query":"스모크 테스트 curl 의사결정","limit":3,"topic":"smoke-test"}}}')
EXP_CHECK=$(echo "$REC_RAW" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    d = json.loads(r['result']['content'][0]['text'])
    frags = d.get('fragments', [])
    # explanations 필드 존재 여부 확인 (빈 배열도 아닌 실제 데이터)
    has_exp = any(isinstance(f.get('explanations'), list) and len(f['explanations']) > 0 for f in frags)
    # 필드 자체의 passthrough 여부 확인 (값이 없어도 키가 있으면 OK)
    has_key = any('explanations' in f for f in frags)
    print('1' if (has_exp or has_key) else '0')
except Exception as e:
    print('0')
" 2>/dev/null || echo "0")
FRAG_COUNT=$(echo "$REC_RAW" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    d = json.loads(r['result']['content'][0]['text'])
    print(len(d.get('fragments', [])))
except:
    print(0)
" 2>/dev/null || echo "0")
printf "  fragments_returned=%s  explanations_present=%s\n" "$FRAG_COUNT" "$EXP_CHECK"
check "recall 응답에 explanations passthrough 동작" "$EXP_CHECK"

# ─── Case 6: Hard gate API 키 생성 ──────────────────────────────────
say "6. Hard gate 테스트용 API 키 생성 (Node inline)"
KEY_JSON=$(node --input-type=module << 'EOF'
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({
  host    : process.env.POSTGRES_HOST,
  port    : Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user    : process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

const name   = 'smoke-hard-gate-' + Date.now();
const slug   = 'smokehg';
const random = randomBytes(16).toString('hex');
const rawKey = `mmcp_${slug}_${random}`;
const hash   = createHash('sha256').update(rawKey).digest('hex');
const prefix = rawKey.slice(0, 14);

const { rows } = await pool.query(`
  INSERT INTO agent_memory.api_keys (name, key_hash, key_prefix, permissions, daily_limit, fragment_limit, symbolic_hard_gate)
  VALUES ($1, $2, $3, $4, $5, $6, true)
  RETURNING id, name, key_prefix
`, [name, hash, prefix, ['read','write'], 1000, 10000]);

console.log(JSON.stringify({ ...rows[0], raw_key: rawKey }));
await pool.end();
EOF
2>/dev/null)

HG_API_KEY_ID=$(echo "$KEY_JSON" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('id',''))" 2>/dev/null || echo "")
HG_KEY=$(echo       "$KEY_JSON" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('raw_key',''))" 2>/dev/null || echo "")
printf "  key_id=%s\n" "$HG_API_KEY_ID"
check "테스트 API 키 생성 (symbolic_hard_gate=true)" "$([ -n "$HG_API_KEY_ID" ] && echo 1 || echo 0)"

# ─── Case 7: Hard gate — JSON-RPC -32003 기대 ───────────────────────
say "7. Hard gate 키로 bad remember — JSON-RPC -32003 기대"
if [ -n "$HG_KEY" ]; then
  # hard gate 키용 세션 초기화
  HG_HDR=$(mktemp)
  curl -s -D "$HG_HDR" -X POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $HG_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hg","version":"1"}}}' \
    > /dev/null
  HG_SESSION=$(grep -i "^mcp-session-id:" "$HG_HDR" | awk '{print $2}' | tr -d '\r')
  rm -f "$HG_HDR"

  HG_RESP=$(mcp_call \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"remember","arguments":{"agentId":"hg","type":"decision","content":"hard gate smoke test: 이 의사결정은 아무런 설명 없이 그냥 선택한 것입니다.","importance":0.5,"keywords":["hg","gate","test"]}}}' \
    "$HG_KEY" "$HG_SESSION")
  printf "  response: %s\n" "$HG_RESP"

  HG_CODE=$(echo "$HG_RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)
print(r.get('error',{}).get('code','missing'))
" 2>/dev/null || echo "missing")

  HG_VIOL=$(echo "$HG_RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)
viols=r.get('error',{}).get('data',{}).get('violations',[])
print(','.join(viols))
" 2>/dev/null || echo "")

  printf "  error_code=%s  violations=%s\n" "$HG_CODE" "$HG_VIOL"
  check "JSON-RPC 에러 코드 -32003"                            "$([ "$HG_CODE" = "-32003" ] && echo 1 || echo 0)"
  check "error.data.violations에 decisionHasRationale 포함"   "$(echo "$HG_VIOL" | grep -q "decisionHasRationale" && echo 1 || echo 0)"
else
  printf "  SKIP: API 키 생성 실패로 hard gate 테스트 불가\n"
  fail=$((fail+2))
fi

# ─── Case 8: Prometheus /metrics auth 포함 조회 ─────────────────────
say "8. Prometheus /metrics — auth 포함 조회 시 memento_symbolic_* 노출 확인"
MET_COUNT=$(curl -s -H "Authorization: Bearer $ACCESS_KEY" "$BASE_URL/metrics" 2>/dev/null \
  | grep -c "^memento_symbolic" || true)
printf "  memento_symbolic_* lines: %s\n" "$MET_COUNT"
check "/metrics에 memento_symbolic_* 1건 이상 노출" "$([ "${MET_COUNT:-0}" -gt 0 ] && echo 1 || echo 0)"

# cleanup은 EXIT trap에서 자동 실행
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
