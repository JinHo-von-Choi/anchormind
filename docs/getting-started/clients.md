# 클라이언트별 연결

AnchorMind는 MCP 표준 서버(Streamable HTTP)다. 서버 주소는 `http://localhost:57332/mcp`이고, 인증에는 `Authorization: Bearer <액세스 키>` 헤더를 쓴다.

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

공통 설정은 서버 URL `http://localhost:57332/mcp`와 Authorization 헤더의 `Bearer YOUR_ACCESS_KEY`다.

## OAuth 연동 (Claude.ai Web, ChatGPT)

Claude.ai Web / ChatGPT 연동에는 OAuth를 쓴다. 발급한 API 키(`mmcp_xxx`)를 `client_id`로 입력하면 Dynamic Client Registration(RFC 7591)을 거치지 않고 바로 연결된다. claude.ai, chatgpt.com처럼 신뢰 도메인으로 등록된 redirect URI는 자동 승인된다.

`POST /register`에 API 키를 `Authorization: Bearer`로 보내 등록한 클라이언트, 즉 키에 묶인 클라이언트는 인가 요청 때마다 동의 화면을 거친다. 토큰 교환에서는 같은 키를 `client_secret`으로 보내거나 Basic 인증으로 제시해야 한다. 제시하지 않으면 `POST /token`이 401 `invalid_client`를 반환한다. `/register`는 프로세스당 시간당 `MEMENTO_DCR_MAX_PER_HOUR`건까지 받는다. 기본값은 100이고, 0이면 상한이 없다. 한도를 넘으면 429를 반환하며 `Retry-After`에는 현재 창에 남은 초가 들어간다. 키에 묶인 등록은 따로 계산한다.

## Codex Desktop의 도구 탐색

Codex Desktop 등 일부 MCP 클라이언트는 deferred/lazy tool discovery를 쓴다. 그래서 tool_search는 검색어와 limit에 따라 일부 도구만 보여줄 수 있고, 항상 존재하는 recall도 저장 쪽으로 치우친 쿼리나 낮은 limit에서는 빠질 수 있다. recall이 보이지 않으면 쿼리를 넓히고 limit을 20 이상으로 올려 다시 검색한다. 짧게 말해, 한 번 안 보였다고 없는 도구로 보면 안 된다. 권장 방식은 에이전트 system prompt/instructions에 이 재검색 규칙을 미리 넣어 초기 discovery 루프를 막는 것이다.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 이상
