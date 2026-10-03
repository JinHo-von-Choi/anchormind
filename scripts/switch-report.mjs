#!/usr/bin/env node
/**
 * 스위치 보고
 *
 * config/switches.js의 레지스트리를 현재 프로세스 환경으로 평가해 스위치마다 적용 값, 기본값,
 * on/off, 기본과 다른지를 마크다운 표로 출력한다. 릴리스 보고와 운영 점검에 쓴다.
 *
 * 환경은 process.env만 읽는다. .env 파일은 읽지 않으므로 보고 대상 환경은 실행하는 쪽이 정한다.
 *   set -a; . /경로/.env; set +a; node scripts/switch-report.mjs
 * 레지스트리에는 기능 스위치만 있고 키, 토큰, 주소는 없다. 잘못된 원본 값은 출력하지 않는다.
 *
 * 사용: node scripts/switch-report.mjs   (npm run switches)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describeSwitches, summarizeSwitches, formatSwitchTable } from "../config/switches.js";

const states  = describeSwitches(process.env);
const summary = summarizeSwitches(process.env);

const lines = [
  "## 스위치 현황",
  "",
  `전체 ${summary.total}개: on ${summary.on}, off ${summary.off}, mode ${summary.mode}, 기본과 다름 ${summary.nonDefaultCount}, 값 오류 ${summary.invalid.length}`,
  "",
  formatSwitchTable(states),
  ""
];

process.stdout.write(lines.join("\n"));
