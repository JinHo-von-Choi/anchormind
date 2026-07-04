#!/usr/bin/env bash
# run-e2e-tests.sh — Docker 기반 E2E 테스트 러너
#
# 작성자: 최진호
# 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
#
# 목적: docker-compose.test.yml의 postgres-test 컨테이너를 기동하고
#       migration을 적용한 뒤 tests/e2e/*.test.js를 실행한다.
# 호출 조건: CI/CD 파이프라인 또는 대규모 리팩터링 후 회귀 검증
# 빈도: CI마다 또는 릴리즈 전
# 의존: Docker, docker compose, .env.test, PostgreSQL
# 관련 문서: docs/operations/maintenance.md

set -euo pipefail

echo "[e2e] PostgreSQL 컨테이너 기동..."
docker compose -f docker-compose.test.yml up -d postgres-test

echo "[e2e] 헬스체크 대기..."
docker compose -f docker-compose.test.yml exec postgres-test \
  pg_isready -U memento -d memento_test

echo "[e2e] 마이그레이션 실행..."
for f in lib/memory/migrations/migration-*.sql; do
  psql postgresql://memento:memento_test@localhost:35433/memento_test -f "$f"
done

echo "[e2e] 테스트 실행..."
node --env-file=.env.test --test tests/e2e/*.test.js

echo "[e2e] 컨테이너 정리..."
docker compose -f docker-compose.test.yml down
