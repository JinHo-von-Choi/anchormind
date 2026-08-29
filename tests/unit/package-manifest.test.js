/**
 * 배포 매니페스트 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-29
 *
 * files allowlist가 없던 시절 배포물에 시험 344개 파일과 미사용 구 로고 5.8MB가
 * 함께 실렸다. 반대로 allowlist를 좁게 잡으면 관리 콘솔 정적 자산과 마이그레이션
 * 러너가 빠져 설치 후 기능이 깨진다.
 *
 * 런타임에 필요한 것이 빠지지 않았는지, 필요 없는 것이 들어오지 않는지를 함께
 * 고정한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PKG  = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** 런타임이 파일 경로로 직접 읽는 자산. 빠지면 설치 후 기능이 깨진다. */
const RUNTIME_ASSETS = [
  "assets/admin/index.html",
  "assets/admin/admin.js",
  "assets/admin/admin.css",
  "lib/memory/memory-schema.sql",
  "scripts/migrate.js",
  "config/memory.js",
  "bin/memento.js",
  "server.js"
];

/** allowlist 항목이 덮는지 판정한다. */
function covered(relPath) {
  return (PKG.files || []).some(entry =>
    entry === relPath || (entry.endsWith("/") && relPath.startsWith(entry))
  );
}

describe("배포 매니페스트", () => {
  test("files allowlist가 선언돼 있다", () => {
    assert.ok(Array.isArray(PKG.files) && PKG.files.length > 0, "files가 없으면 저장소 전체가 실린다");
  });

  test("런타임 자산이 모두 덮인다", () => {
    const missing = RUNTIME_ASSETS.filter(f => !covered(f));
    assert.deepEqual(missing, [], `배포물에서 빠지는 런타임 자산: ${missing.join(", ")}`);
  });

  test("런타임 자산이 저장소에 실제로 있다", () => {
    const absent = RUNTIME_ASSETS.filter(f => !existsSync(path.join(ROOT, f)));
    assert.deepEqual(absent, [], `경로가 바뀐 자산: ${absent.join(", ")}`);
  });

  test("시험과 내부 문서는 덮이지 않는다", () => {
    for (const p of ["tests/unit/package-manifest.test.js", "docs/plans/x.md", "docs/internals.md"]) {
      assert.equal(covered(p), false, `${p}가 배포물에 실린다`);
    }
  });

  test("구 브랜드 로고가 저장소에 남아 있지 않다", () => {
    assert.equal(existsSync(path.join(ROOT, "assets", "images", "memento_mcp_logo.png")), false);
  });

  test("저장소 좌표가 선언돼 있다", () => {
    assert.match(PKG.repository?.url ?? "", /anchormind/);
    assert.match(PKG.bugs?.url ?? "", /anchormind/);
  });

  test("실행 진입점이 두 이름으로 등록돼 있다", () => {
    assert.ok(PKG.bin?.anchormind, "anchormind 진입점이 없다");
    assert.ok(PKG.bin?.["memento-mcp"], "기존 이름 호환 진입점이 없다");
  });

  test("런타임 지원 범위가 선언돼 있다", () => {
    assert.match(PKG.engines?.node ?? "", /\d+/);
  });
});
