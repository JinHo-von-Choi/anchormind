/**
 * 환경 변수 직접 접근 대장
 *
 * 새 환경 변수는 lib/config.js나 config/ 아래 중앙 모듈에서 envInt, envBool, envEnum 같은 도우미로 읽는다.
 * 이 파일은 그 밖의 파일이 process.env를 직접 읽는 예외를 사유와 함께 적는다.
 * scripts/env-access-report.mjs가 코드를 구문 분석해 이 대장과 맞는지 검사하고,
 * tests/structure/env-access.test.js가 같은 검사를 시험으로 돌린다.
 *
 * 분류(kind)는 코드에서 판정한 값과 일치해야 한다.
 *   startup: 모듈 최상위에서 읽는다. 적재 때 한 번 고정되므로 이후 환경 변경이 반영되지 않는다.
 *   runtime: 함수 안에서 읽는다. 호출할 때마다 읽으므로 환경 변경이 바로 반영된다.
 *   cli    : lib/cli와 bin의 CLI 진입점이 읽거나 process.env에 쓴다.
 * vars의 "(env)"는 process.env를 통째로 도우미 함수에 넘기는 지점이다. 읽는 변수는 그 도우미가 정한다.
 *
 * runtime 항목을 startup으로 옮기면 런타임 토글이 먹통이 된다. 옮기려면 호출 시점 변경 시험을 함께 둔다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

/** 모든 직접 읽기를 허용하는 중앙 모듈. config/ 아래 파일은 모두 중앙 모듈이다. */
export const CENTRAL_MODULES = Object.freeze(["lib/config.js"]);

export const ENV_ACCESS = Object.freeze([
  {
    file  : "bin/memento.js",
    kind  : "cli",
    vars  : ["(env)", "PATH", "PATHEXT", "MEMENTO_LOG_STDERR", "MEMENTO_CLI_REMOTE", "UPDATE_CHECK_DISABLED", "UPDATE_CHECK_INTERVAL_HOURS", "GITHUB_TOKEN"],
    reason: "CLI 진입점이다. 명령에 따라 환경을 읽고 로그 출력 위치(MEMENTO_LOG_STDERR)를 정한다. 환경 전체는 훅 원격 주소 해석과 admin 명령에 넘긴다."
  },
  {
    file  : "lib/admin/ApiKeyStore.js",
    kind  : "runtime",
    vars  : ["MEMENTO_API_KEY_DELETE_GUARD"],
    reason: "키 삭제 보호 스위치다. 삭제 요청마다 읽어 운영 중 토글을 반영한다."
  },
  {
    file  : "lib/admin/admin-metrics.js",
    kind  : "startup",
    vars  : ["(env)"],
    reason: "관리 지표 표본 수집 여부(readAdminMetricsSampling)를 적재 때 한 번 정한다."
  },
  {
    file  : "lib/cli/backfill.js",
    kind  : "cli",
    vars  : ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"],
    reason: "DATABASE_URL이 없으면 POSTGRES_* 값으로 조립해 process.env에 쓴다. 이후 DB 모듈이 읽는다."
  },
  {
    file  : "lib/cli/cleanup.js",
    kind  : "cli",
    vars  : ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"],
    reason: "DATABASE_URL이 없으면 POSTGRES_* 값으로 조립해 process.env에 쓴다. 이후 DB 모듈이 읽는다."
  },
  {
    file  : "lib/cli/migrate.js",
    kind  : "cli",
    vars  : ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"],
    reason: "DATABASE_URL이 없으면 POSTGRES_* 값으로 조립해 process.env에 쓴다. 이후 DB 모듈이 읽는다."
  },
  ...["inspect", "recall", "remember", "session", "stats"].map((name) => ({
    file  : `lib/cli/${name}.js`,
    kind  : "cli",
    vars  : ["MEMENTO_CLI_REMOTE", "MEMENTO_CLI_KEY"],
    reason: "원격 모드의 주소와 키다. 플래그가 없을 때만 환경 변수를 쓴다."
  })),
  {
    file  : "lib/cli/update.js",
    kind  : "cli",
    vars  : ["GITHUB_TOKEN", "(env)"],
    reason: "업데이트 확인에 쓰는 GitHub 토큰과, 설치 방식을 다시 판정할 때 넘기는 환경이다."
  },
  {
    file  : "lib/compression.js",
    kind  : "startup",
    vars  : ["MIN_COMPRESS_SIZE", "COMPRESSION_LEVEL"],
    reason: "응답 압축 임계와 수준을 적재 때 한 번 고정한다."
  },
  {
    file  : "lib/handlers/_common.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "CORS 모드(readCorsMode)를 요청마다 읽는다."
  },
  {
    file  : "lib/handlers/_rotate-ratelimit.js",
    kind  : "runtime",
    vars  : ["MEMENTO_ROTATE_RATE_LIMIT_PER_MIN"],
    reason: "세션 회전의 분당 제한을 호출 때마다 읽는다."
  },
  {
    file  : "lib/handlers/health-handler.js",
    kind  : "runtime",
    vars  : ["WORKER_ID"],
    reason: "헬스 응답에 워커 식별자를 싣는다."
  },
  {
    file  : "lib/handlers/oauth-handler.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "OAuth redirect 검사 모드(readOauthRedirectCheck)를 요청마다 읽는다."
  },
  {
    file  : "lib/handlers/sse-handler.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "레거시 SSE 쿼리 키 모드(readSseQueryKey)를 요청마다 읽는다."
  },
  {
    file  : "lib/http/helpers.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "X-Frame-Options 모드(readFrameOptions)를 응답마다 읽는다."
  },
  {
    file  : "lib/jsonrpc.js",
    kind  : "runtime",
    vars  : ["MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN", "(env)"],
    reason: "도구 인자 검증 모드와 알 수 없는 필드 허용 여부를 호출마다 읽는다."
  },
  {
    file  : "lib/llm/util/cli-env.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "CLI provider에 넘길 환경을 호출 시점의 환경에서 만든다(env 인자의 기본값)."
  },
  {
    file  : "lib/logger.js",
    kind  : "startup",
    vars  : ["NODE_ENV", "LOG_LEVEL"],
    reason: "로거 구성을 적재 때 한 번 고정한다."
  },
  {
    file  : "lib/memory/embedding/EmbeddingCache.js",
    kind  : "runtime",
    vars  : ["EMBEDDING_MODEL"],
    reason: "캐시 키에 넣을 모델 이름을 호출마다 읽는다."
  },
  {
    file  : "lib/memory/processors/EpisodeContinuityService.js",
    kind  : "startup",
    vars  : ["EPISODE_CONTINUITY_CACHE_TTL_MS"],
    reason: "에피소드 연속성 캐시의 TTL을 적재 때 한 번 고정한다."
  },
  {
    file  : "lib/memory/processors/MemoryRecaller.js",
    kind  : "runtime",
    vars  : ["ENABLE_SPREADING_ACTIVATION"],
    reason: "확산 활성화 스위치다. recall마다 읽어 런타임 토글을 반영한다."
  },
  {
    file  : "lib/memory/processors/MemoryRememberer.js",
    kind  : "runtime",
    vars  : ["MEMENTO_REMEMBER_ATOMIC"],
    reason: "remember 원자화 스위치다. 호출마다 읽는다."
  },
  {
    file  : "lib/memory/read/QueryProfile.js",
    kind  : "runtime",
    vars  : ["MEMENTO_QUERY_PROFILE_ENABLED"],
    reason: "질의 프로파일 스위치다. 호출마다 읽는다."
  },
  {
    file  : "lib/memory/signals/CaseRewardBackprop.js",
    kind  : "runtime",
    vars  : ["MEMENTO_CASE_BACKPROP_ENABLED"],
    reason: "사례 보상 역전파 스위치다. 호출마다 평가해 런타임 토글을 즉시 반영하며 시험도 이 동작에 기댄다."
  },
  {
    file  : "lib/memory/signals/MemoryEvaluator.js",
    kind  : "startup",
    vars  : ["EVALUATOR_MAX_QUEUE"],
    reason: "평가 대기열의 최대 길이를 적재 때 한 번 고정한다."
  },
  {
    file  : "lib/memory/signals/SearchParamAdaptor.js",
    kind  : "runtime",
    vars  : ["MEMENTO_RECALL_MIN_SIM_FLOOR", "MEMENTO_RECALL_MIN_SIM_CEIL"],
    reason: "검색 유사도 하한과 상한을 조정할 때마다 읽는다."
  },
  {
    file  : "lib/memory/write/BatchRememberProcessor.js",
    kind  : "startup",
    vars  : ["BATCH_REMEMBER_MAX_TOTAL_CHARS"],
    reason: "배치 저장의 총 문자 수 상한을 적재 때 한 번 고정한다."
  },
  {
    file  : "lib/memory/write/ConflictResolver.js",
    kind  : "runtime",
    vars  : ["ENABLE_RECONSOLIDATION"],
    reason: "링크 재조정 스위치다. 호출마다 읽어 런타임 토글을 반영한다."
  },
  {
    file  : "lib/metrics.js",
    kind  : "startup",
    vars  : ["(env)"],
    reason: "기본 지표 수집 여부(readMetricsDefault)를 적재 때 한 번 정한다."
  },
  {
    file  : "lib/tools/db.js",
    kind  : "runtime",
    vars  : ["BATCH_DATABASE_URL", "(env)"],
    reason: "배치 풀 URL은 풀을 만들 때, 벡터 색인 강제 여부(readVectorForceIndex)는 질의 때 읽는다."
  },
  {
    file  : "lib/tools/memory.js",
    kind  : "runtime",
    vars  : ["ENABLE_RECONSOLIDATION"],
    reason: "링크 재조정 스위치다. tool_feedback 처리마다 읽는다."
  },
  {
    file  : "lib/tools/update-tools.js",
    kind  : "runtime",
    vars  : ["GITHUB_TOKEN"],
    reason: "업데이트 확인 도구가 호출될 때마다 GitHub 토큰을 읽는다."
  },
  {
    file  : "lib/updater/install-detector.js",
    kind  : "runtime",
    vars  : ["(env)"],
    reason: "설치 방식 판정에 쓰는 환경이다. 호출자가 env를 주입하지 않으면 현재 환경을 쓴다."
  },
  {
    file  : "lib/updater/update-executor.js",
    kind  : "runtime",
    vars  : ["UPDATE_REQUIRE_SIGNED_TAG"],
    reason: "서명된 태그 요구 여부를 업데이트 실행 때마다 읽는다."
  }
]);
