/**
 * outbox 기록 SQL
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * outbox_events INSERT 문의 단일 위치. lib/outbox/Outbox.js의 enqueue와, 설정 모듈을 불러오지 않아야 하는 로컬
 * 명령(lib/cli/admin.js의 비상 복구 감사 기록)이 같은 문장을 쓴다. 매개변수: topic, aggregate_id, payload(JSON 문자열),
 * 전달 지연 ms.
 */

import { SCHEMA } from "../memory/schema.js";

export const OUTBOX_INSERT_SQL = `
  INSERT INTO ${SCHEMA}.outbox_events (topic, aggregate_id, payload, available_at)
  VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4::double precision / 1000))
  RETURNING id`;
