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

## Codex에서 기억 도구가 쓰이게 하기

Codex(CLI와 Desktop)는 MCP 도구를 모델에 바로 보여 주지 않고, 모델이 도구 목록을 검색해야 찾게 둔다. 연결만 해 두면 Codex는 세션마다 AnchorMind에 접속해 도구 목록만 받고, 사용자가 "지난번에 뭘 했지?"처럼 기억을 직접 묻지 않는 한 도구를 부르지 않는다. 둘 중 하나를 설정한다.

1. 지침: `~/.codex/AGENTS.md`(모든 프로젝트) 또는 프로젝트의 `AGENTS.md`에 아래 내용을 넣는다.

   ```markdown
   # AnchorMind 기억

   AnchorMind MCP 서버(`anchormind`)가 연결돼 있다. 도구가 목록에 바로 보이지 않으면 도구 검색으로 `anchormind`를 찾아 쓴다.

   - 작업을 시작하면 먼저 `context`로 지난 기억을 불러온다.
   - 과거 작업, 설정, 오류를 다루기 전에 `recall`로 관련 기억을 찾는다.
   - 결정, 해결한 오류의 원인과 해법, 사용자 선호가 확정되면 `remember`로 저장한다.
   - 작업을 마치면 `reflect`로 요약을 남긴다. 다른 작업에서도 쓸 교훈은 `lessons`에 상황(cue), 할 일(lesson), 근거(evidence)로 적는다.
   ```

2. 훅: 세션 시작 때 기억을 자동으로 넣고 끝날 때 회고를 남긴다. [훅 설정](hooks.md#codex) 또는 [플러그인 설치](plugins.md)를 따른다.

도구 검색으로 찾을 때는 검색어를 넓게(`anchormind context recall remember reflect`), 결과 수를 20 이상으로 준다. 한 번 안 보였다고 없는 도구가 아니다.
