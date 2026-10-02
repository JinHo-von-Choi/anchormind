# Vendored scripts

작성자: 최진호
작성일: 2026-10-03

콘솔(`assets/admin/index.html`)이 읽는 외부 라이브러리 사본. 파일을 교체하면 이 표와 `tests/unit/admin-console-assets.test.js` 의 sha256 값을 함께 갱신한다.

| 파일 | 버전 | 출처 | sha256 |
|-|-|-|-|
| tailwindcss-3.4.17.js | tailwindcss 3.4.17 (forms 0.5.10, container-queries 0.1.1) | https://cdn.tailwindcss.com/3.4.17?plugins=forms@0.5.10,container-queries@0.1.1 | a789ce5a73191759006b64a0c05f63afbf9aa43a86511bf798d688737429e60a |
| d3-7.9.0.min.js | d3 7.9.0 | npm 패키지 d3@7.9.0 의 dist/d3.min.js | f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539 |
