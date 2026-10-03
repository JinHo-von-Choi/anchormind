-- 본문 어휘 채널의 토큰 열
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- content_tokens는 본문의 형태소 토큰을 공백으로 이어 'simple' 구성으로 만든 tsvector다.
-- 기본값 없는 nullable 열이라 기존 행을 다시 쓰지 않는다. NULL은 아직 채우지 않은 행이고,
-- 새로 쓰는 행은 저장 경로가 채우며 기존 행은 scripts/ops/backfill-content-tokens.mjs가 채운다.
-- 검색용 GIN 색인(idx_fragments_content_tokens)은 이 파일이 아니라 scripts/ops/online-index.mjs가
-- 만든다(scripts/ops/index-manifest.json, docs/operations/online-migration.md).
-- 열 추가는 짧게 표 전체 잠금을 잡으므로 잠금 대기를 3초로 제한한다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS content_tokens tsvector;

COMMENT ON COLUMN agent_memory.fragments.content_tokens
  IS '본문 형태소 토큰의 tsvector(simple). NULL은 아직 채우지 않은 행이며 어휘 채널 검색에서 빠진다';
