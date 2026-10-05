# Contributing to Memento MCP

## Development Setup

1. Clone the repository
2. `cp .env.example .env` and configure
3. Start PostgreSQL with pgvector: `docker-compose -f docker-compose.test.yml up -d`
4. `npm install`
5. `npm run migrate`
6. `npm test`

### Full Development Stack

For a complete local environment with PostgreSQL + Redis:

```bash
docker-compose -f docker-compose.dev.yml up -d
cp .env.example .env  # Edit DB credentials to match dev compose
npm install
npm run migrate
node server.js
```

### Docker Build

```bash
docker build -t memento-mcp .
```

## Code Style

- ESM imports only (no require)
- All SQL queries use parameterized binding ($1, $2)
- Error logging via Winston (logInfo, logWarn, logError from lib/logger.js)
- Variables: const by default, let when mutation needed

## Architecture: lib/memory/processors/

`lib/memory/MemoryManager.js`는 얇은 facade이고, 실제 처리는 `lib/memory/processors/`의 MemoryRememberer / MemoryRecaller / MemoryReflector / MemoryLinker 4개 클래스가 책임별로 나눠 맡는다.

- MemoryRememberer: `remember` / `batchRemember`
- MemoryRecaller: `recall` / `context`
- MemoryReflector: `reflect`
- MemoryLinker: `link`, `deleteByAgent` (`graph_explore`는 `lib/tools/memory.js`의 `tool_graphExplore`가 처리)

facade와 프로세서 간 공유 프로퍼티(embedder, fragmentStore 등)는 `_installSharedSync` 패턴으로 동기화된다. 외부에서 facade의 세터를 호출하면 모든 프로세서에 자동 전파되므로 외부 인터페이스는 변경이 없다.

테스트에서 메서드 본문을 검증할 때는 `MemoryManager.prototype.remember.toString()` 대신 `MemoryRememberer.prototype.remember.toString()`을 사용한다.

`ContradictionDetector`는 `MemoryManager`를 직접 가져오지 않는다. 모순 해소 감사 기록이 필요한 생성 경로는 `MemoryConsolidator({ rememberAudit })` 또는 `ContradictionDetector(store, { rememberAudit })`로 콜백을 주입한다. 독립 생성에서 콜백을 생략하면 감사 기록만 건너뛰며 모순 해소는 유지된다.

## LLM CLI 경계

- `lib/llm/providers/*CliProvider.js`: provider 계약과 설정 fallback
- `lib/llm/runners/*.js`: CLI 바이너리 확인과 프로세스 실행
- `lib/{agy,codex,copilot,gemini,opencode,qwen}.js`: 기존 공개 import 호환 shim

새 CLI provider는 provider에서 raw runner를 직접 import한다. 다른 모듈에서 runner를 직접 호출하거나 provider에서 호환 shim을 import하면 구조 시험이 실패한다. 공개 shim 경로와 export는 호환성 때문에 유지한다.

## Admin 라우트 등록

라우트를 추가할 때 `lib/admin/admin-route-table.js`와 실제 처리 모듈을 함께 갱신한다. 새 처리 모듈은 `lib/admin/admin-handler-registry.js`에 명시적 순서로 등록한다. `admin-routes`와 `admin-user-auth`는 직접 처리 모듈이라 레지스트리 대상이 아니다. `/audit/export` 순서를 보존하기 위해 `admin-audit`는 `admin-export`보다 앞에 둔다.

## Testing

- Unit tests: `tests/unit/` (node:test runner)
- Integration tests: `tests/integration/` — `npm run test:integration` runs via node:test
- E2E tests: `tests/e2e/` (requires PostgreSQL)
- DB concurrency tests: `tests/db-concurrency/` - `npm run test:db` (requires PostgreSQL; creates and drops a dedicated database per run)
- Run all unit tests: `npm test`
- Unit tests with coverage: `npm run test:coverage` compares line, branch and function coverage totals with `coverage-baseline.json` (tolerance 0.5 percentage points) through `scripts/check-coverage.js`. Lowering the baseline needs `--allow-decrease`
- Import cycles: `node scripts/import-cycles.js` lists cycles of size 2 or more among relative imports under `lib`, `config`, `scripts`, `bin` and `server.js`; a unit test requires zero static and zero dynamic-inclusive cycles

### 신규 unit 테스트 작성 시 lifecycle 가드 필수

unit 테스트가 `lib/sessions.js`, `lib/redis.js`, `lib/memory/processors/ReflectProcessor.js` 등
timer 또는 socket을 활성화하는 모듈을 import하면 after 훅에서 반드시 정리해야 한다.
정리 후 `assertCleanShutdown()`을 호출하여 hang 패턴 재유입을 즉시 감지한다.

```js
import { assertCleanShutdown } from "../_lifecycle.js";
import { redisClient }         from "../../lib/redis.js";

after(async () => {
  try { await redisClient.quit(); }    catch (_) {}
  try {
    const { getPrimaryPool } = await import("../../lib/tools/db.js");
    await getPrimaryPool()?.end();
  } catch (_) {}
  await assertCleanShutdown();
});
```

- prom-client default metrics는 `MEMENTO_METRICS_DEFAULT=off`로 무력화된다.
  `npm test` 스크립트가 이 환경변수를 자동 주입한다.
  단일 파일 실행 시에도 `MEMENTO_METRICS_DEFAULT=off node --experimental-test-module-mocks --test tests/unit/<file>.test.js`로 실행한다.
- 회귀 가드: `tests/unit/test-lifecycle-guard.test.js`가 헬퍼 동작을 검증한다.
- 상세 내용: `tests/README.md` §Lifecycle 가드 참조

## Pull Request Checklist

- [ ] `npm test` passes; with PostgreSQL available, `npm run test:integration` (integration + e2e) passes. CI runs these as separate jobs in `.github/workflows/test.yml` (unit with lint, lint ratchet, migration lint and coverage; runtime boot on Node 22 and 24; e2e; DB concurrency, reported without failing the workflow). Dependency audit runs in `.github/workflows/audit.yml`
- [ ] `npm run lint && npm run lint:ratchet` passes
- [ ] New migration file if DB schema changed; run `npm run lint:migrations` to verify body-only convention (see `docs/migration-conventions.md`)
- [ ] New boolean or enum environment switch: entry in `config/switches.js`, `.env.example`, `docs/configuration.md` and `docs/configuration.en.md` (`tests/unit/switch-ledger-structure.test.js` fails on a missing entry); `npm run switches -- --strict` exits 0
- [ ] New environment variable: read it in `lib/config.js` or `config/`; a direct read in any other file is registered with a reason in `config/env-access.js` (`npm run env-access -- --strict`, enforced by `tests/structure/env-access.test.js`)
- [ ] `docs/features.md` ledger updated for any new or removed feature
- [ ] `docs/concurrency.md` updated if a new write path is introduced
- [ ] CHANGELOG.md updated
- [ ] SKILL.md updated if tool parameters changed
- [ ] 신규 unit 테스트에 `assertCleanShutdown()` 추가 (lifecycle 가드 — `tests/README.md` 참조)

`npm run lint:ratchet` compares per-file lint metrics with `scripts/lint-baseline.json`. When a metric drops, lower the ceiling with `node scripts/lint-ratchet.js --update`; the command refuses to write if any metric grew. Raising a ceiling needs `node scripts/lint-ratchet.js --update --allow-increase`, which is reserved for the integration owner or an owner-approved regeneration.

## Commit Messages

Format: `[영역] 설명` (예: `[HTTP] 응답 공통 헤더 추가`, `[문서] 연결 설정 안내 현행화`)

## 릴리스

`npm run release -- X.Y.Z`가 작업 트리와 HEAD의 Tests 워크플로 결과를 확인한 뒤 CHANGELOG의 [Unreleased]를 버전 절로 옮기고 package.json, package-lock.json, SKILL.md, SECURITY.md의 버전 표기를 갱신한다. lint, 마이그레이션 lint, 단위 시험이 통과하면 `release: X.Y.Z` 커밋과 annotated tag를 만들고, push와 `gh release create` 명령을 출력한다. push와 Release 생성은 출력된 명령으로 직접 한다.

main 브랜치에서만 실행되며 다른 브랜치는 `--allow-branch`를 줘야 한다. 분리된 HEAD는 `--allow-branch`를 줘도 거부한다. lint, 시험, 커밋 중 하나가 실패하면 갱신된 파일이 그대로 남고(커밋 단계 실패면 스테이징된 채) 자동 되돌리기는 없다. `git checkout HEAD -- CHANGELOG.md package.json package-lock.json SKILL.md SECURITY.md`로 인덱스와 작업 트리를 함께 되돌린 뒤 원인을 고치고 다시 실행한다.

마이그레이션 파일이 포함된 릴리스는 운영에 반영하기 직전에 `scripts/ops/backup.sh --label pre-migration`으로 백업을 만든다. 라벨 벌은 일일 백업의 보관 정리에서 제외된다. 종료 코드 0과 `written:` 네 줄, 그리고 벌의 시각이 반영 직전인지 확인한 뒤에 `npm run migrate`를 실행한다. 백업이 없으면 마이그레이션을 실행하지 않는다. 절차와 복구 훈련은 `docs/operations/backup-restore.md`에 있다.
