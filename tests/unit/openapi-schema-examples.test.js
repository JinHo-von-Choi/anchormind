import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * L8 OpenAPI examples + schema description 보강 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

describe("openapi-schema-examples: rememberDefinition", () => {
  test("content에 examples 배열이 존재한다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.content.examples), "content.examples는 배열이어야 한다");
    assert.ok(props.content.examples.length >= 1, "examples에 항목이 1개 이상이어야 한다");
  });

  test("type에 examples 배열이 존재하고 enum 값을 포함한다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.type.examples), "type.examples는 배열이어야 한다");
    const allowed = ["fact", "decision", "error", "preference", "procedure", "relation", "episode"];
    for (const ex of props.type.examples) {
      assert.ok(allowed.includes(ex), `type.examples의 '${ex}'는 enum 값이어야 한다`);
    }
  });

  test("topic에 examples 배열이 존재한다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.topic.examples), "topic.examples는 배열이어야 한다");
    assert.ok(props.topic.examples.length >= 1, "topic.examples에 항목이 1개 이상이어야 한다");
  });

  test("idempotencyKey에 examples 배열이 존재한다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.idempotencyKey.examples), "idempotencyKey.examples는 배열이어야 한다");
    assert.ok(
      props.idempotencyKey.examples.some(e => e.includes("2026")),
      "idempotencyKey.examples에 날짜 형식 예시가 포함되어야 한다"
    );
  });

  test("top-level description이 3줄(\\n) 이상이다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const lines = rememberDefinition.description.split("\n").filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 3, `description이 최소 3줄이어야 한다 (현재 ${lines.length}줄)`);
  });

  test("importance에 examples 배열이 존재하고 0~1 범위다", async () => {
    const { rememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = rememberDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.importance.examples), "importance.examples는 배열이어야 한다");
    for (const ex of props.importance.examples) {
      assert.ok(ex >= 0 && ex <= 1, `importance.examples의 ${ex}는 0~1 범위여야 한다`);
    }
  });
});

describe("openapi-schema-examples: recallDefinition", () => {
  test("fields에 examples 배열이 존재하고 각 항목이 배열이다", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = recallDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.fields.examples), "fields.examples는 배열이어야 한다");
    assert.ok(props.fields.examples.length >= 1, "fields.examples에 항목이 1개 이상이어야 한다");
    for (const ex of props.fields.examples) {
      assert.ok(Array.isArray(ex), "fields.examples의 각 항목은 배열이어야 한다");
      assert.ok(ex.includes("id"), "fields.examples의 각 항목에 id 필드가 포함되어야 한다");
      assert.ok(ex.includes("content"), "fields.examples의 각 항목에 content 필드가 포함되어야 한다");
    }
  });

  test("keywords에 examples 배열이 존재하고 각 항목이 배열이다", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = recallDefinition.inputSchema.properties;
    assert.ok(Array.isArray(props.keywords.examples), "keywords.examples는 배열이어야 한다");
    for (const ex of props.keywords.examples) {
      assert.ok(Array.isArray(ex), "keywords.examples의 각 항목은 배열이어야 한다");
    }
  });

  test("description에 _meta 응답 구조 설명이 포함된다", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    assert.ok(
      recallDefinition.description.includes("_meta"),
      "recallDefinition.description에 _meta 응답 구조 언급이 필요하다"
    );
    assert.ok(
      recallDefinition.description.includes("searchEventId"),
      "recallDefinition.description에 searchEventId 언급이 필요하다"
    );
  });

  test("top-level description이 3줄 이상이다", async () => {
    const { recallDefinition } = await import("../../lib/tools/memory-schemas.js");
    const lines = recallDefinition.description.split("\n").filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 3, `recallDefinition.description이 최소 3줄이어야 한다 (현재 ${lines.length}줄)`);
  });
});

/** 도구 정의 모듈. link 정의는 lib/tools/link-schema.js에 있다. */
async function loadDefinitions() {
  return { ...(await import("../../lib/tools/memory-schemas.js")), ...(await import("../../lib/tools/link-schema.js")) };
}

describe("openapi-schema-examples: dryRun examples", () => {
  const DRYRYN_DEFINITIONS = [
    "rememberDefinition",
    "forgetDefinition",
    "linkDefinition",
    "amendDefinition"
  ];

  for (const defName of DRYRYN_DEFINITIONS) {
    test(`${defName}.dryRun에 examples [true, false]가 존재한다`, async () => {
      const mod = await loadDefinitions();
      const def = mod[defName];
      assert.ok(def, `${defName}이 export되어야 한다`);
      const dryRun = def.inputSchema.properties.dryRun;
      assert.ok(dryRun, `${defName}.properties.dryRun이 존재해야 한다`);
      assert.ok(Array.isArray(dryRun.examples), `${defName}.dryRun.examples는 배열이어야 한다`);
      assert.ok(dryRun.examples.includes(true), `${defName}.dryRun.examples에 true가 포함되어야 한다`);
      assert.ok(dryRun.examples.includes(false), `${defName}.dryRun.examples에 false가 포함되어야 한다`);
    });
  }
});

describe("openapi-schema-examples: description 충분한 길이(80자 이상) 검증", () => {
  // description은 JS 문자열 연결로 작성되어 \n이 없을 수 있다.
  // 의미 있는 보강 여부는 최소 문자 길이(80자)와 마침표 기준 2문장 이상으로 검증한다.
  const MULTI_LINE_DEFINITIONS = [
    "batchRememberDefinition",
    "forgetDefinition",
    "linkDefinition",
    "amendDefinition",
    "reflectDefinition",
    "contextDefinition",
    "toolFeedbackDefinition",
    "memoryConsolidateDefinition",
    "graphExploreDefinition",
    "fragmentHistoryDefinition",
    "getSkillGuideDefinition",
    "reconstructHistoryDefinition",
    "searchTracesDefinition"
  ];

  for (const defName of MULTI_LINE_DEFINITIONS) {
    test(`${defName}.description이 한 줄 초과(80자 이상, 2문장 이상)다`, async () => {
      const mod = await loadDefinitions();
      const def = mod[defName];
      assert.ok(def, `${defName}이 export되어야 한다`);
      const desc = def.description;
      assert.ok(
        desc.length >= 80,
        `${defName}.description이 최소 80자여야 한다 (현재 ${desc.length}자)`
      );
      // 마침표로 끝나는 문장 수 (. 또는 다) 계산
      const sentences = desc.split(/[.다]\s+/).filter(s => s.trim().length > 0);
      assert.ok(
        sentences.length >= 2,
        `${defName}.description이 최소 2문장이어야 한다 (현재 ${sentences.length}문장)`
      );
    });
  }
});

describe("openapi-schema-examples: batchRememberDefinition", () => {
  test("fragments 항목의 idempotencyKey에 examples가 존재한다", async () => {
    const { batchRememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const itemProps = batchRememberDefinition.inputSchema.properties.fragments.items.properties;
    assert.ok(
      Array.isArray(itemProps.idempotencyKey.examples),
      "fragments.items.idempotencyKey.examples는 배열이어야 한다"
    );
  });

  test("stream에 examples [true, false]가 존재한다", async () => {
    const { batchRememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const stream = batchRememberDefinition.inputSchema.properties.stream;
    assert.ok(Array.isArray(stream.examples), "stream.examples는 배열이어야 한다");
    assert.ok(stream.examples.includes(true), "stream.examples에 true가 포함되어야 한다");
    assert.ok(stream.examples.includes(false), "stream.examples에 false가 포함되어야 한다");
  });
});
