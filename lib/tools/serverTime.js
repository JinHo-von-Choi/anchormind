/**
 * 서버 현재 시각 메타 생성기.
 *
 * 작성자: 최진호
 * 작성일: 2026-05-15
 *
 * LLM 클라이언트의 학습 시점 고착으로 인한 시간 오류를 방지하기 위해
 * recall/context 응답에 일관되게 주입하는 메타 필드를 생성한다.
 *
 * 반환 구조:
 *   - iso        : UTC ISO 8601 (정확한 기계 파싱용)
 *   - epoch_ms   : Unix epoch milliseconds
 *   - display_kst: 한국어 친화 표기 (Asia/Seoul, "2026년 5월 15일 (목) 14:32")
 *   - timezone   : 표기 타임존 라벨
 */

const KST_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone : "Asia/Seoul",
  year     : "numeric",
  month    : "long",
  day      : "numeric",
  weekday  : "short",
  hour     : "2-digit",
  minute   : "2-digit",
  hour12   : false
});

export function serverTimeMeta() {
  const now = new Date();
  return {
    iso        : now.toISOString(),
    epoch_ms   : now.getTime(),
    display_kst: KST_FORMATTER.format(now),
    timezone   : "Asia/Seoul"
  };
}
