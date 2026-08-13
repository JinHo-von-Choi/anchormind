# 프로덕션 Docker 배포와 재부팅 복구

작성자: 최진호
작성일: 2026-08-13

셀프호스팅 환경에서 AnchorMind를 Docker Compose로 상시 운영할 때의 구성 예시와,
호스트 재부팅·Docker 엔진 재시작 후 무인 복구 패턴을 다룬다. (이슈 #53 대응)

저장소의 `docker-compose.dev.yml`·`docker-compose.test.yml`은 개발·테스트 전용으로
restart 정책이 없다. 프로덕션은 아래 예시를 프로젝트 외부 경로에 복사해 사용한다.

## Compose 예시

```yaml
# docker-compose.prod.yml — 환경에 맞게 조정해 사용한다.
#   docker compose -p anchormind -f docker-compose.prod.yml up -d
services:
  postgres:
    image: pgvector/pgvector:pg15
    restart: unless-stopped
    environment:
      POSTGRES_DB:       ${POSTGRES_DB:-memento}
      POSTGRES_USER:     ${POSTGRES_USER:-memento}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD를 .env에 설정하라}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-memento} -d ${POSTGRES_DB:-memento}"]
      interval: 5s
      timeout: 5s
      retries: 12
      start_period: 20s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # 인증이 필요하면: command: ["redis-server", "--appendonly", "yes", "--requirepass", "${REDIS_PASSWORD}"]
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  # DB 마이그레이션 one-shot. 앱보다 먼저 완료되어야 한다.
  migrate:
    build: .
    restart: "no"
    command: ["node", "scripts/migrate.js"]
    env_file: .env
    environment:
      POSTGRES_HOST: postgres   # 컨테이너 내부에서는 localhost가 아니라 서비스명이다
      REDIS_HOST: redis
    depends_on:
      postgres:
        condition: service_healthy

  anchormind:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_HOST: postgres
      REDIS_HOST: redis
      HF_HOME: /root/.cache/huggingface
    ports:
      - "127.0.0.1:57332:57332"   # 외부 노출은 리버스 프록시 뒤에서만
    volumes:
      - hf_cache:/root/.cache/huggingface   # 로컬 임베딩 모델 재다운로드 방지
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    # 이미지(node:24-alpine)에 curl이 없어 node로 검사한다.
    # /health는 Redis 단절 시 degraded 상태로도 HTTP 200을 반환하므로 status 값을 파싱해야 한다.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:57332/health').then(r=>r.json()).then(j=>process.exit(j.status==='healthy'?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 10s
      retries: 8
      start_period: 300s   # 최초 기동 시 로컬 임베딩 모델 다운로드(수 분)를 견딘다
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  pgdata:
  redisdata:
  hf_cache:
```

구성 원칙:

- DB·Redis는 호스트 포트를 게시하지 않는다(compose 내부 네트워크 전용). 앱만 `127.0.0.1`로
  바인딩하고, 외부 노출은 리버스 프록시에서 TLS와 함께 처리한다.
- `.env`는 저장소 비내장일 뿐 비밀 보호 수단이 아니다. 파일 권한(600), 최소 권한 DB 계정을
  함께 적용한다. 접근 키를 커맨드라인·로그에 싣지 않는다.
- 이미지 태그를 고정한다. 태그가 움직이면 재부팅이 무계획 업그레이드가 된다. PostgreSQL
  메이저 업그레이드는 볼륨 호환성 문제로 별도 절차(덤프·복원)가 필요하다.
- `pgdata`·`redisdata` 볼륨은 백업 대상이다.

## restart 정책 선택

`unless-stopped`를 기본으로 권장한다. 두 정책은 호스트 재부팅·엔진 재시작 시의 복구 동작이
동일하고, 차이는 운영자가 `docker stop`으로 의도적으로 내린 컨테이너뿐이다 —
`unless-stopped`는 내려둔 상태를 존중하고, `always`는 재부팅 때 되살린다. 유지보수·롤백 중
재부팅이 끼어들 때 내려둔 스택이 되살아나면 곤란하므로 기본값은 `unless-stopped`가 안전하다.
사람이 개입할 수 없는 완전 무인 장비라면 `always`를 선택한다.

## 재부팅 복구

Linux 호스트: `systemctl enable docker`로 엔진 자동 시작만 보장하면 restart 정책이 나머지를
처리한다. 별도 부트스트랩이 필요 없다.

Windows(Docker Desktop, WSL2 백엔드): Docker Desktop 설정의 "Start Docker Desktop when you
sign in"을 켜면 로그인 시 엔진이 기동하고, restart 정책이 컨테이너를 복구한다. 대부분의
환경은 이 두 가지로 충분하다.

로그인 부트스트랩이 추가로 필요한 환경(엔진 기동 실패 재시도, 기동 완료 확인이 필요한 경우)은
다음 시퀀스를 예약 작업(Task Scheduler 등)으로 구성한다:

1. `docker info`가 성공할 때까지 대기하고, 실패가 지속되면 Docker Desktop을 기동한다.
2. 고정 프로젝트명으로 `docker compose -p anchormind -f <경로> up -d`를 실행한다.
   `--remove-orphans`는 쓰지 않는다 — 같은 프로젝트의 다른 의도적 컨테이너를 삭제할 수 있다.
3. `/health` 응답의 `status` 값이 `healthy`가 될 때까지 대기한다. HTTP 200만 확인하면
   Redis가 단절된 `degraded` 상태를 정상으로 오판한다.
4. 동시 실행을 직렬화하고(뮤텍스), 로그에 자격증명을 남기지 않으며, 예약 작업의 제거·롤백
   절차를 함께 문서화한다.

이 저장소는 Windows용 부트스트랩 스크립트를 직접 유지하지 않는다. 유지보수 환경이 Linux라
Windows 스크립트는 검증 없이 부패하기 때문이다. 위 시퀀스를 구현·검증한 스크립트의 기여(PR)는
환영하며, 리뷰 기준은 경로 설정화, 자격증명 비내장·비로깅, 충돌 배포 시 실패 종료, 제거·롤백
절차 문서화다.
