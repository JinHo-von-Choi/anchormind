# 클라이언트별 연결

AnchorMind는 MCP 표준 서버(Streamable HTTP)다. 서버 주소는 `http://localhost:57332/mcp`, 인증은 `Authorization: Bearer <액세스 키>` 헤더다.

## 플랫폼

| 플랫폼 | 설정 위치 | 연결 방식 |
|--------|----------|-----------|
| Claude Code | `claude mcp add` CLI (`~/.claude.json`) 또는 `.mcp.json` | Streamable HTTP |
| Claude Desktop | claude_desktop_config.json | Streamable HTTP |
| Claude.ai Web | Settings > Integrations | OAuth (RFC 7591) |
| Cursor | .cursor/mcp.json | Streamable HTTP |
| Windsurf | ~/.codeium/windsurf/mcp_config.json | Streamable HTTP |
| GitHub Copilot | VS Code MCP Marketplace | Streamable HTTP |
| Codex CLI | ~/.codex/config.toml | Streamable HTTP |
| ChatGPT Desktop | Developer Mode > Apps | OAuth (RFC 7591) |
| Continue | config.json | Streamable HTTP |

공통 설정: 서버 URL `http://localhost:57332/mcp`, Authorization 헤더에 `Bearer YOUR_ACCESS_KEY`.

## OAuth 연동 (Claude.ai Web, ChatGPT)

Claude.ai Web / ChatGPT 연동은 OAuth를 사용한다. 발급한 API 키(`mmcp_xxx`)를 `client_id`로 입력하면 Dynamic Client Registration(RFC 7591) 없이 바로 연결된다. 신뢰 도메인(claude.ai, chatgpt.com)의 redirect URI는 자동 승인된다.

`POST /register`에 API 키를 `Authorization: Bearer`로 보내 등록한 클라이언트(키에 묶인 클라이언트)는 인가 요청마다 동의 화면을 거치고, 토큰 교환에서 같은 키를 `client_secret`(또는 Basic 인증)으로 제시해야 한다. 제시하지 않으면 `POST /token`이 401 `invalid_client`를 돌려준다. `/register`는 프로세스당 시간당 `MEMENTO_DCR_MAX_PER_HOUR`(기본 100, 0은 상한 없음)건까지 받고 초과하면 429(`Retry-After`는 현재 창의 남은 초)를 돌려준다. 키에 묶인 등록은 따로 센다.

## Codex Desktop의 도구 탐색

Codex Desktop 등 일부 MCP 클라이언트는 deferred/lazy tool discovery를 쓴다. tool_search가 검색어와 limit에 따라 일부 도구만 노출하므로, 항상 존재하는 recall이 저장 편향 쿼리+낮은 limit에서 빠질 수 있다. recall이 안 보이면 더 넓은 쿼리와 limit 20 이상으로 재검색한다. 권장: 에이전트 system prompt/instructions에 이 재검색 규칙을 미리 심어 초기 discovery 루프를 차단한다.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 이상
