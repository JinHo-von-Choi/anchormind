/**
 * 검색 평가 세트 형식, 검증, 적재 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 형식 검사와 구조 검사만 한다. 동봉 평가 세트의 질의 수나 내용을 고정하지 않는다.
 */

import { test, describe }                 from "node:test";
import assert                             from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir }                         from "node:os";
import path                               from "node:path";
import { fileURLToPath }                  from "node:url";

import {
  SUBSETS, TAGS, EXAMPLE_FILE, HUMAN_QUERY_TARGET, EvalSetError,
  parseJsonl, validateEvalEntry, validateEvalSet, splitLabeled, coverageReport, loadEvalDir
} from "../../lib/memory/signals/RecallEvalSet.js";

const here       = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../fixtures/recall-eval-v2");

const human = (over = {}) => ({
  id: "hk-1", subset: "human_ko", domain: "ops", query: "백업 위치가 어디였지",
  relevant: [{ id: "frag-a", grade: 3 }], ...over
});

describe("parseJsonl", () => {
  test("빈 줄과 // 줄을 건너뛴다", () => {
    assert.deepEqual(parseJsonl('// c\n\n{"a":1}\n  {"b":2}  \n', "x"), [{ a: 1 }, { b: 2 }]);
  });

  test("파싱 실패는 이름과 줄 번호를 담는다", () => {
    assert.throws(() => parseJsonl('{"a":1}\n{oops}', "set.jsonl"), /set\.jsonl 2번째 줄 파싱 실패/);
  });
});

describe("validateEvalEntry", () => {
  test("올바른 항목은 사유가 없다", () => {
    assert.deepEqual(validateEvalEntry(human(), 0, "human_ko"), []);
  });

  test("객체가 아니면 거부한다", () => {
    assert.equal(validateEvalEntry(null, 0).length, 1);
    assert.equal(validateEvalEntry([], 0).length, 1);
  });

  test("알 수 없는 필드를 거부한다", () => {
    assert.ok(validateEvalEntry(human({ relevent: [] }), 0).some(e => e.includes('"relevent"')));
  });

  test("파일의 부분집합과 다른 subset을 거부한다", () => {
    assert.ok(validateEvalEntry(human(), 0, "identifier").some(e => e.includes("파일의 부분집합")));
  });

  test("id 형식과 query 누락을 거부한다", () => {
    const errors = validateEvalEntry(human({ id: "한글 id", query: " " }), 0);
    assert.ok(errors.some(e => e.includes("id")));
    assert.ok(errors.some(e => e.includes("query 누락")));
  });

  test("human_ko는 domain과 한글 질의를 요구한다", () => {
    assert.ok(validateEvalEntry(human({ domain: undefined }), 0).some(e => e.includes("domain")));
    assert.ok(validateEvalEntry(human({ query: "where is the backup" }), 0).some(e => e.includes("한글")));
    assert.ok(validateEvalEntry(human({ domain: "misc" }), 0).some(e => e.includes("domain")));
  });

  test("tag는 허용 목록, 중복 없음, 질의 문자 조건을 지킨다", () => {
    assert.ok(validateEvalEntry(human({ tags: ["unknown"] }), 0).some(e => e.includes("알 수 없는 tag")));
    assert.ok(validateEvalEntry(human({ tags: ["spacing", "spacing"] }), 0).some(e => e.includes("중복")));
    assert.ok(validateEvalEntry(human({ tags: ["en_identifier"] }), 0).some(e => e.includes("영문자")));
    assert.ok(validateEvalEntry(human({ tags: ["mixed_ko_en"], query: "한글만 있는 질의" }), 0).some(e => e.includes("한글과 영문자")));
    assert.deepEqual(validateEvalEntry(human({ tags: ["mixed_ko_en"], query: "recall 설정이 어디지" }), 0), []);
  });

  test("keywords는 비어 있지 않은 문자열의 짧은 배열이다", () => {
    assert.deepEqual(validateEvalEntry(human({ keywords: ["백업", "위치"] }), 0), []);
    assert.ok(validateEvalEntry(human({ keywords: "백업" }), 0).some(e => e.includes("keywords")));
    assert.ok(validateEvalEntry(human({ keywords: [""] }), 0).some(e => e.includes("keywords")));
    assert.ok(validateEvalEntry(human({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }), 0).some(e => e.includes("keywords")));
  });

  test("relevant는 등급 1~3, id 중복 없음을 지킨다", () => {
    assert.ok(validateEvalEntry(human({ relevant: [{ id: "a", grade: 4 }] }), 0).some(e => e.includes("grade")));
    assert.ok(validateEvalEntry(human({ relevant: [{ id: "a", grade: 1 }, { id: "a", grade: 2 }] }), 0).some(e => e.includes("중복")));
    assert.ok(validateEvalEntry(human({ relevant: [{ grade: 1 }] }), 0).some(e => e.includes("id가 없다")));
    assert.ok(validateEvalEntry(human({ relevant: "frag-a" }), 0).some(e => e.includes("배열")));
  });

  test("distractors는 relevant와 겹치지 않는다", () => {
    assert.ok(validateEvalEntry(human({ distractors: ["frag-a"] }), 0).some(e => e.includes("겹친다")));
    assert.ok(validateEvalEntry(human({ distractors: [1] }), 0).some(e => e.includes("distractors")));
    assert.deepEqual(validateEvalEntry(human({ distractors: ["frag-b"] }), 0), []);
  });

  test("referenceDate는 temporal_holdout에서만 쓰고 필수이며 날짜여야 한다", () => {
    const base = { id: "th-1", subset: "temporal_holdout", query: "지난달 일정" };
    assert.ok(validateEvalEntry(base, 0).some(e => e.includes("referenceDate")));
    assert.ok(validateEvalEntry({ ...base, referenceDate: "2026-13-45" }, 0).some(e => e.includes("referenceDate")));
    assert.deepEqual(validateEvalEntry({ ...base, referenceDate: "2026-01-31" }, 0), []);
    assert.ok(validateEvalEntry(human({ referenceDate: "2026-01-31" }), 0).some(e => e.includes("temporal_holdout에서만")));
  });
});

describe("validateEvalSet", () => {
  test("id 중복과 같은 workspace의 질의 중복을 잡는다", () => {
    const errors = validateEvalSet([human(), human({ id: "hk-1", query: "다른 질의" }), human({ id: "hk-2" })]);
    assert.ok(errors.some(e => e.includes("id 중복")));
    assert.ok(errors.some(e => e.includes("질의 중복")));
  });

  test("workspace가 다르면 같은 질의도 허용한다", () => {
    assert.deepEqual(validateEvalSet([human({ workspace: "a" }), human({ id: "hk-2", workspace: "b" })]), []);
  });

  test("배열이 아니면 거부한다", () => {
    assert.equal(validateEvalSet({}).length, 1);
  });
});

describe("splitLabeled와 coverageReport", () => {
  const entries = [
    human(),
    human({ id: "hk-2", query: "다른 질의", relevant: undefined, tags: ["particle"] }),
    { id: "id-1", subset: "identifier", query: "FOO_BAR", tags: ["en_identifier"], relevant: [{ id: "x", grade: 1 }] }
  ];

  test("relevant가 없거나 비면 미라벨이다", () => {
    const { labeled, unlabeled } = splitLabeled(entries);
    assert.deepEqual(labeled.map(e => e.id), ["hk-1", "id-1"]);
    assert.deepEqual(unlabeled.map(e => e.id), ["hk-2"]);
  });

  test("부분집합과 tag별 건수와 사람 작성 질의 목표 대비를 낸다", () => {
    const report = coverageReport(entries);
    assert.deepEqual(report.subsets.human_ko, { total: 2, labeled: 1, unlabeled: 1 });
    assert.deepEqual(report.subsets.identifier, { total: 1, labeled: 1, unlabeled: 0 });
    assert.equal(report.subsets.synthetic.total, 0);
    assert.equal(report.tags.particle, 1);
    assert.deepEqual(report.human_ko, { labeled: 1, target: HUMAN_QUERY_TARGET, met: false });
    assert.equal(Object.keys(report.subsets).length, SUBSETS.length);
  });
});

describe("loadEvalDir", () => {
  const withDir = async (files, fn) => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-set-"));
    try {
      for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, name), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("있는 부분집합 파일만 읽고 없는 파일은 건너뛴다", async () => {
    await withDir({ "human_ko.jsonl": [human()] }, async (dir) => {
      const { entries, files } = await loadEvalDir(dir);
      assert.deepEqual(files, ["human_ko.jsonl"]);
      assert.equal(entries.length, 1);
    });
  });

  test("subsets 옵션으로 읽을 파일을 고른다", async () => {
    const files = { "human_ko.jsonl": [human()], "identifier.jsonl": [{ id: "i1", subset: "identifier", query: "FOO" }] };
    await withDir(files, async (dir) => {
      const { entries } = await loadEvalDir(dir, { subsets: ["identifier"] });
      assert.deepEqual(entries.map(e => e.id), ["i1"]);
    });
  });

  test("알 수 없는 부분집합 이름은 EvalSetError다", async () => {
    await withDir({}, async (dir) => {
      await assert.rejects(loadEvalDir(dir, { subsets: ["nope"] }), EvalSetError);
    });
  });

  test("형식 위반은 사유 목록을 담은 EvalSetError다", async () => {
    await withDir({ "human_ko.jsonl": [human({ domain: undefined })] }, async (dir) => {
      await assert.rejects(loadEvalDir(dir), (err) => err instanceof EvalSetError && err.details.length > 0);
    });
  });

  test("파일 사이의 id 중복을 거부한다", async () => {
    const files = { "human_ko.jsonl": [human()], "identifier.jsonl": [{ id: "hk-1", subset: "identifier", query: "FOO" }] };
    await withDir(files, async (dir) => {
      await assert.rejects(loadEvalDir(dir), /id 중복/);
    });
  });

  test("예시 파일은 includeExamples일 때만 읽는다", async () => {
    await withDir({ [EXAMPLE_FILE]: [human({ example: true })] }, async (dir) => {
      assert.equal((await loadEvalDir(dir)).entries.length, 0);
      assert.equal((await loadEvalDir(dir, { includeExamples: true })).entries.length, 1);
    });
  });
});

describe("동봉 평가 세트 구조", () => {
  test("부분집합 파일과 예시 파일은 모두 형식 검사를 통과한다", async () => {
    const present = (await readdir(fixtureDir)).filter(f => f.endsWith(".jsonl"));
    assert.ok(present.includes(EXAMPLE_FILE), "예시 파일이 있어야 한다");
    for (const file of present) {
      const entries = parseJsonl(await readFile(path.join(fixtureDir, file), "utf-8"), file);
      const stem    = file.replace(/\.jsonl$/, "");
      assert.ok(SUBSETS.includes(stem) || file === EXAMPLE_FILE, `${file} 은 부분집합 이름이 아니다`);
      assert.deepEqual(validateEvalSet(entries, file === EXAMPLE_FILE ? undefined : stem), [], file);
    }
  });

  test("예시 파일의 모든 줄은 example 표지가 있고 다른 파일에는 없다", async () => {
    for (const file of (await readdir(fixtureDir)).filter(f => f.endsWith(".jsonl"))) {
      const entries = parseJsonl(await readFile(path.join(fixtureDir, file), "utf-8"), file);
      for (const entry of entries) {
        assert.equal(entry.example === true, file === EXAMPLE_FILE, `${file} ${entry.id}`);
      }
    }
  });

  test("파일 사이에 id가 겹치지 않는다", async () => {
    const ids = [];
    for (const file of (await readdir(fixtureDir)).filter(f => f.endsWith(".jsonl"))) {
      ids.push(...parseJsonl(await readFile(path.join(fixtureDir, file), "utf-8"), file).map(e => e.id));
    }
    assert.equal(new Set(ids).size, ids.length);
  });

  test("예시 파일은 모든 부분집합과 모든 tag를 한 번 이상 보인다", async () => {
    const entries = parseJsonl(await readFile(path.join(fixtureDir, EXAMPLE_FILE), "utf-8"), EXAMPLE_FILE);
    assert.deepEqual(new Set(entries.map(e => e.subset)), new Set(SUBSETS));
    const tags = new Set(entries.flatMap(e => e.tags ?? []));
    assert.ok(["en_identifier", "mixed_ko_en", "particle", "spacing"].every(t => tags.has(t)), `tags ${[...tags]}`);
    assert.ok(TAGS.every(t => tags.has(t)));
  });

  test("README가 파일 형식과 질의 추가 절차를 담는다", async () => {
    const readme = await readFile(path.join(fixtureDir, "README.md"), "utf-8");
    for (const word of ["human_ko.jsonl", "relevant", "referenceDate", "example.jsonl", "150"]) {
      assert.ok(readme.includes(word), word);
    }
  });
});
