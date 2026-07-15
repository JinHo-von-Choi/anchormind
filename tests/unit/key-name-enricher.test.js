/**
 * KeyNameEnricher 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-15
 *
 * attachKeyNames 순수 매핑 로직 검증: 행 매칭, 미매칭 파편 보존, key_name null 처리.
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

import { teardownTestResources } from "../_lifecycle.js";
import { attachKeyNames }        from "../../lib/memory/read/KeyNameEnricher.js";

after(async () => {
  await teardownTestResources();
});

describe("attachKeyNames", () => {
  it("행이 매칭되면 key_id와 key_name을 덧붙인다", () => {
    const fragments = [{ id: "frag-a", content: "x" }];
    const rows      = [{ id: "frag-a", key_id: "key-1", key_name: "jinho" }];
    const result    = attachKeyNames(fragments, rows);
    assert.equal(result[0].key_id,   "key-1");
    assert.equal(result[0].key_name, "jinho");
    assert.equal(result[0].content,  "x");
  });

  it("매칭 행이 없는 파편은 원본 그대로 반환한다", () => {
    const fragments = [{ id: "frag-b", content: "y" }];
    const result    = attachKeyNames(fragments, []);
    assert.deepEqual(result[0], { id: "frag-b", content: "y" });
    assert.ok(!("key_name" in result[0]));
  });

  it("api_keys에 이름이 없으면 key_name은 null이다", () => {
    const fragments = [{ id: "frag-c" }];
    const rows      = [{ id: "frag-c", key_id: "key-2", key_name: null }];
    const result    = attachKeyNames(fragments, rows);
    assert.equal(result[0].key_id,   "key-2");
    assert.equal(result[0].key_name, null);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const fragments = [{ id: "frag-d" }];
    const rows      = [{ id: "frag-d", key_id: "key-3", key_name: "n" }];
    attachKeyNames(fragments, rows);
    assert.ok(!("key_id" in fragments[0]));
  });
});
