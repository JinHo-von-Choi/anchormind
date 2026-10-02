/**
 * README 벤치마크 수치와 벤치마크 문서의 정합 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * README 벤치마크 표의 백분율이 docs/benchmark.md 의 소수 표기로 존재하는지,
 * 논문 링크가 LongMemEval(arXiv 2410.10813)을 가리키는지 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** "## 벤치마크" 또는 "## Benchmark" 절 본문만 잘라낸다. */
function benchmarkSection(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `${heading} 절이 없다`);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
}

const DOC_KO = read("docs/benchmark.md");

describe("README 벤치마크 절", () => {
  for (const [file, heading] of [["README.md", "벤치마크"], ["README.en.md", "Benchmark"]]) {
    const section = benchmarkSection(read(file), heading);

    it(`${file}: 표의 백분율은 docs/benchmark.md 의 소수 값과 같다`, () => {
      const percents = [...section.matchAll(/\|\s*([0-9]+\.[0-9])%\s*\|/g)].map(m => Number(m[1]));
      assert.ok(percents.length >= 2, "표에서 백분율을 찾지 못했다");
      for (const p of percents) {
        const decimal = (p / 100).toFixed(3);
        assert.ok(DOC_KO.includes(decimal), `${p}% 에 해당하는 ${decimal} 이 docs/benchmark.md 에 없다`);
      }
    });

    it(`${file}: LongMemEval 링크는 arXiv 2410.10813 이다`, () => {
      assert.match(section, /arxiv\.org\/abs\/2410\.10813/);
      assert.doesNotMatch(section, /2407\.15460/);
    });
  }

  it("벤치마크 문서의 논문 링크도 2410.10813 이다", () => {
    for (const file of ["docs/benchmark.md", "docs/benchmark.en.md"]) {
      assert.doesNotMatch(read(file), /2407\.15460/, file);
    }
  });
});
