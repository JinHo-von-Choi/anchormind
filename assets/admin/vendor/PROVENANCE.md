# Vendored scripts

작성자: 최진호
작성일: 2026-10-03

그래프가 필요할 때 D3를 읽는다. 이전 콘솔과 롤링 전환할 수 있도록 Tailwind 스크립트 URL을 유지한다. 현재 콘솔의 유틸리티 CSS는 `npm run build:admin-css`로 생성한다. 파일을 교체하면 이 표와 자산 시험의 sha256 값을 갱신하고, D3의 경우 그래프 모듈이 사용하는 버전 해시도 갱신한다.

| 파일 | 버전 | 출처 | sha256 |
|-|-|-|-|
| tailwindcss-3.4.17.js | tailwindcss 3.4.17 (forms 0.5.10, container-queries 0.1.1) | https://cdn.tailwindcss.com/3.4.17?plugins=forms@0.5.10,container-queries@0.1.1 | a789ce5a73191759006b64a0c05f63afbf9aa43a86511bf798d688737429e60a |
| d3-7.9.0.min.js | d3 7.9.0 | npm 패키지 d3@7.9.0 의 dist/d3.min.js | f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539 |
