/**
 * SKILL.md 섹션 경계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * get_skill_guide(section)가 저장소 루트 SKILL.md에서 잘라 내는 섹션 이름과 경계 정규식이다.
 * 하네스 플러그인 스킬의 핵심본은 상세 내용을 이 섹션 이름으로 참조하므로, 도구 처리기와 구조 검사가
 * 같은 표를 쓴다. 모듈을 가져오지 않는 잎 모듈이다.
 */

/** SKILL.md 섹션 매핑 */
export const SKILL_SECTIONS = Object.freeze({
  overview:      /^## 서버 개요[\s\S]*?(?=^## )/m,
  lifecycle:     /^## 세션 생명주기 프로토콜[\s\S]*?(?=^## )/m,
  keywords:      /^## 키워드 작성 규칙[\s\S]*?(?=^## )/m,
  search:        /^## 검색 전략 의사결정 트리[\s\S]*?(?=^## )/m,
  episode:       /^## 에피소드 기억 활용[\s\S]*?(?=^## )/m,
  multiplatform: /^## 다중 플랫폼[\s\S]*?(?=^## )/m,
  collaboration: /^## 멀티에이전트 협업[\s\S]*?(?=^## )/m,
  codex:         /^## Codex Desktop[\s\S]*?(?=^## )/m,
  tools:         /^## 도구 레퍼런스[\s\S]*?(?=^## 중요도)/m,
  importance:    /^## 중요도 기본값[\s\S]*?(?=^## )/m,
  experiential:  /^## 경험적 기억 활용[\s\S]*?(?=^## )/m,
  cbr:           /^## CBR[\s\S]*?(?=^## )/m,
  triggers:      /^## 능동 활용 트리거[\s\S]*?(?=^## )/m,
  workspace:     /^### workspace 파라미터 기입 규칙[\s\S]*?(?=^### |^## )/m,
  antipatterns:  /^## 안티패턴[\s\S]*/m,
});
