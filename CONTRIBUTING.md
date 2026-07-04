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

`lib/memory/processors/` 디렉토리는 v2.10.0(Phase 5-B)에서 MemoryManager를 1252줄에서 259줄 facade로 축소하면서 신설됐다. MemoryRememberer / MemoryRecaller / MemoryReflector / MemoryLinker 4개 클래스가 책임별로 분리되어 있다.

- MemoryRememberer: `remember` / `batchRemember`
- MemoryRecaller: `recall` / `context`
- MemoryReflector: `reflect`
- MemoryLinker: `link` / `graph_explore`

facade와 프로세서 간 공유 프로퍼티(embedder, fragmentStore 등)는 `_installSharedSync` 패턴으로 동기화된다. 외부에서 facade의 세터를 호출하면 모든 프로세서에 자동 전파되므로 외부 인터페이스는 변경이 없다.

테스트에서 메서드 본문을 검증할 때는 `MemoryManager.prototype.remember.toString()` 대신 `MemoryRememberer.prototype.remember.toString()`을 사용한다.

## Testing

- Unit tests: `tests/unit/` (node:test runner)
- Integration tests: `tests/integration/` — `npm run test:integration` runs via node:test
- E2E tests: `tests/e2e/` (requires PostgreSQL)
- Run all unit tests: `npm test`

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
- 회귀 가드: `tests/unit/test-lifecycle-guard.test.js` 5 케이스가 헬퍼 동작을 검증한다.
- 상세 내용: `tests/README.md` §Lifecycle 가드 참조

## Pull Request Checklist

- [ ] `npm run test:ci` passes (`npm test && npm run test:integration`) — CI single gate
- [ ] `npx eslint . --max-warnings 0` passes
- [ ] New migration file if DB schema changed; run `npm run lint:migrations` to verify body-only convention (see `docs/migration-conventions.md`)
- [ ] `docs/features.md` ledger updated for any new or removed feature
- [ ] `docs/concurrency.md` updated if a new write path is introduced
- [ ] CHANGELOG.md updated
- [ ] SKILL.md updated if tool parameters changed
- [ ] 신규 unit 테스트에 `assertCleanShutdown()` 추가 (lifecycle 가드 — `tests/README.md` 참조)

## Commit Messages

Format: `type: description`
Types: feat, fix, docs, chore, refactor, test
