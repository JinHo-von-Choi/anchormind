/**
 * batch_remember content_hash 중복 접기 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-03
 *
 * 배경:
 *   다중행 INSERT ... ON CONFLICT (key_id, content_hash) DO UPDATE 한 문장에
 *   같은 content_hash가 두 번 들어가면 PostgreSQL이
 *   "ON CONFLICT DO UPDATE command cannot affect row a second time"으로 거부하고
 *   트랜잭션 전체가 롤백된다. reflect가 세션 파편과 수동 입력을 병합하면서
 *   같은 해시를 한 배치에 넣으면 reflect 호출 전체가 실패한다.
 *
 * 검증 범위:
 *  - 같은 content_hash 항목이 대표 하나로 접힌다
 *  - 접힌 항목의 importance는 최대값, is_anchor는 OR로 병합된다
 *  - 대표 외 컬럼은 첫 항목 값을 유지한다(순차 INSERT 시 DO UPDATE 동작과 동일)
 *  - content_hash가 없는 항목은 접지 않는다
 *  - 접힌 원본 인덱스도 대표와 같은 id를 돌려받는다
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { BatchRememberProcessor } from "../../lib/memory/write/BatchRememberProcessor.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

/** _collapseHashDuplicates만 검증하므로 의존성은 비워 둔다. */
function makeProcessor() {
  return new BatchRememberProcessor({ store: {}, index: {}, factory: {} });
}

function item(index, hash, extra = {}) {
  return {
    index,
    fragment: {
      id          : `frag-${index}`,
      content     : `content-${index}`,
      content_hash: hash,
      importance  : 0.5,
      is_anchor   : false,
      topic       : `topic-${index}`,
      ...extra
    }
  };
}

describe("BatchRememberProcessor._collapseHashDuplicates", () => {
  it("같은 content_hash를 대표 하나로 접고 나머지를 alias로 돌려준다", () => {
    const proc = makeProcessor();

    const { unique, aliases } = proc._collapseHashDuplicates([
      item(0, "aaaa"),
      item(1, "bbbb"),
      item(2, "aaaa"),
      item(3, "aaaa")
    ]);

    assert.equal(unique.length, 2);
    assert.deepEqual(unique.map(u => u.index), [0, 1]);
    assert.deepEqual(aliases, [{ from: 2, to: 0 }, { from: 3, to: 0 }]);
  });

  it("importance는 최대값, is_anchor는 OR로 병합한다", () => {
    const proc = makeProcessor();

    const { unique } = proc._collapseHashDuplicates([
      item(0, "aaaa", { importance: 0.4, is_anchor: false }),
      item(1, "aaaa", { importance: 0.9, is_anchor: true  }),
      item(2, "aaaa", { importance: 0.6, is_anchor: false })
    ]);

    assert.equal(unique.length, 1);
    assert.equal(unique[0].fragment.importance, 0.9);
    assert.equal(unique[0].fragment.is_anchor, true);
  });

  it("대표 외 컬럼은 첫 항목 값을 유지한다", () => {
    const proc = makeProcessor();

    const { unique } = proc._collapseHashDuplicates([
      item(0, "aaaa", { topic: "first",  content: "first-content"  }),
      item(1, "aaaa", { topic: "second", content: "second-content" })
    ]);

    assert.equal(unique[0].fragment.topic, "first");
    assert.equal(unique[0].fragment.content, "first-content");
    assert.equal(unique[0].fragment.id, "frag-0");
  });

  it("content_hash가 없는 항목은 접지 않는다", () => {
    const proc = makeProcessor();

    const { unique, aliases } = proc._collapseHashDuplicates([
      item(0, null),
      item(1, undefined),
      item(2, "")
    ]);

    assert.equal(unique.length, 3);
    assert.equal(aliases.length, 0);
  });

  it("중복이 없으면 입력을 그대로 돌려준다", () => {
    const proc = makeProcessor();

    const input = [item(0, "aaaa"), item(1, "bbbb"), item(2, "cccc")];
    const { unique, aliases } = proc._collapseHashDuplicates(input);

    assert.equal(unique.length, 3);
    assert.equal(aliases.length, 0);
  });

  it("접힌 원본 인덱스가 대표와 같은 id를 받도록 alias가 구성된다", () => {
    const proc = makeProcessor();

    const { unique, aliases } = proc._collapseHashDuplicates([
      item(0, "aaaa"),
      item(1, "aaaa")
    ]);

    /** 삽입 후 results 전파를 흉내낸다. */
    const results = [{ success: true, id: null }, { success: true, id: null }];
    results[unique[0].index].id = "frag-stored";
    for (const { from, to } of aliases) results[from].id = results[to].id;

    assert.equal(results[0].id, "frag-stored");
    assert.equal(results[1].id, "frag-stored");
  });
});
