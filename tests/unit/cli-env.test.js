/**
 * LLM CLI 자식 프로세스 환경 구성 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import { buildCliEnv } from "../../lib/llm/util/cli-env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("buildCliEnv", () => {
  const env = {
    PATH              : "/usr/bin",
    HOME              : "/home/u",
    GEMINI_API_KEY    : "g",
    OPENAI_API_KEY    : "o",
    POSTGRES_PASSWORD : "p",
    DATABASE_URL      : "d",
    MEMENTO_ACCESS_KEY: "m"
  };

  it("CLI 별 허용 키만 전달한다", () => {
    const out = buildCliEnv("gemini", {}, env);
    assert.equal(out.GEMINI_API_KEY, "g");
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.POSTGRES_PASSWORD, undefined);
    assert.equal(out.DATABASE_URL, undefined);
    assert.equal(out.MEMENTO_ACCESS_KEY, undefined);
    assert.equal(out.OPENAI_API_KEY, undefined);
  });

  it("MEMENTO_LLM_CLI_ENV_PASSTHROUGH 로 허용 목록을 넓힌다", () => {
    const out = buildCliEnv("gemini", {}, { ...env, MEMENTO_LLM_CLI_ENV_PASSTHROUGH: "OPENAI_API_KEY" });
    assert.equal(out.OPENAI_API_KEY, "o");
  });

  it("extra 는 마지막에 덮어쓴다", () => {
    assert.equal(buildCliEnv("codex", { CODEX_HOME: "/x" }, env).CODEX_HOME, "/x");
  });

  it("LC_ 와 XDG_ 접두 변수를 전달한다", () => {
    const out = buildCliEnv("agy", {}, { ...env, LC_ALL: "C", XDG_CONFIG_HOME: "/c" });
    assert.equal(out.LC_ALL, "C");
    assert.equal(out.XDG_CONFIG_HOME, "/c");
  });
});

describe("CLI provider 자식 프로세스 환경", () => {
  for (const name of ["gemini", "codex", "copilot", "qwen", "agy", "opencode"]) {
    it(`${name} 은 부모 환경 전체를 넘기지 않는다`, () => {
      const src = readFileSync(path.join(ROOT, `lib/${name}.js`), "utf8");
      assert.match(src, /buildCliEnv\(/);
      assert.doesNotMatch(src, /\.\.\.process\.env/);
    });
  }
});
