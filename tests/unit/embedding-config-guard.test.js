/**
 * EMBEDDING_PROVIDER=transformers config 가드 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * config.js는 모듈 로드 시점에 throw하므로 독립 서브프로세스로 격리 검증한다.
 */

import { test, describe } from "node:test";
import assert              from "node:assert/strict";
import { execFileSync }    from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path                from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");

/**
 * 격리된 Node.js 서브프로세스로 config.js를 로드하고 지정 상수값을 반환한다.
 *
 * @param {Object} env      - 추가 환경변수 (process.env 기반으로 override)
 * @param {string} snippet  - 평가할 JS 스니펫 (config 모듈 import 후 실행)
 * @returns {{ stdout: string, exitCode: number }}
 */
function runConfigSnippet(env, snippet) {
  const configUrl = pathToFileURL(path.join(ROOT, "lib", "config.js")).href;
  const script = `
    import("${configUrl}")
      .then(cfg => {
        ${snippet}
      })
      .catch(err => {
        process.stderr.write(err.message + "\\n");
        process.exit(1);
      });
  `;

  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module"], {
      input: script,
      env  : { ...process.env, ...env, DOTENV_SKIP: "1" },
      cwd  : ROOT,
      timeout: 10000
    });
    return { stdout: stdout.toString().trim(), exitCode: 0 };
  } catch (err) {
    return {
      stdout  : "",
      stderr  : (err.stderr || Buffer.alloc(0)).toString().trim(),
      exitCode: err.status ?? 1
    };
  }
}

describe("EMBEDDING_PROVIDER=transformers config 가드", () => {
  test("transformers + OPENAI_API_KEY 동시 설정 시 로드 실패", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER : "transformers",
        OPENAI_API_KEY     : "sk-test-key",
        EMBEDDING_API_KEY  : "",
        GEMINI_API_KEY     : "",
        CF_API_TOKEN       : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write("ok\\n");`
    );
    assert.strictEqual(result.exitCode, 1, "exit code는 1이어야 한다");
    assert.match(
      result.stderr,
      /EMBEDDING_PROVIDER=transformers이면 API 키는 설정하지 마십시오/,
      "에러 메시지에 상호 배타 안내가 포함되어야 한다"
    );
  });

  test("transformers + EMBEDDING_API_KEY 동시 설정 시 로드 실패", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER : "transformers",
        EMBEDDING_API_KEY  : "emb-key-xxx",
        OPENAI_API_KEY     : "",
        GEMINI_API_KEY     : "",
        CF_API_TOKEN       : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write("ok\\n");`
    );
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /데이터 혼합 방지/);
  });

  test("transformers 단독 설정 시 EMBEDDING_ENABLED=true", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER : "transformers",
        OPENAI_API_KEY     : "",
        EMBEDDING_API_KEY  : "",
        GEMINI_API_KEY     : "",
        CF_API_TOKEN       : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_ENABLED) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "true", "EMBEDDING_ENABLED는 true여야 한다");
  });

  test("transformers 기본 모델 dims=384 자동 매핑", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER  : "transformers",
        EMBEDDING_MODEL     : "Xenova/multilingual-e5-small",
        EMBEDDING_DIMENSIONS: "",
        OPENAI_API_KEY      : "",
        EMBEDDING_API_KEY   : "",
        GEMINI_API_KEY      : "",
        CF_API_TOKEN        : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_DIMENSIONS) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "384", "기본 모델 차원은 384여야 한다");
  });

  test("transformers + Xenova/bge-m3 모델 시 dims=1024 자동 매핑", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER  : "transformers",
        EMBEDDING_MODEL     : "Xenova/bge-m3",
        EMBEDDING_DIMENSIONS: "",
        OPENAI_API_KEY      : "",
        EMBEDDING_API_KEY   : "",
        GEMINI_API_KEY      : "",
        CF_API_TOKEN        : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_DIMENSIONS) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "1024", "bge-m3 차원은 1024여야 한다");
  });

  test("EMBEDDING_DIMENSIONS env 명시 시 자동 매핑보다 우선", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER  : "transformers",
        EMBEDDING_MODEL     : "Xenova/bge-m3",
        EMBEDDING_DIMENSIONS: "512",
        OPENAI_API_KEY      : "",
        EMBEDDING_API_KEY   : "",
        GEMINI_API_KEY      : "",
        CF_API_TOKEN        : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_DIMENSIONS) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "512", "명시된 dims 512가 우선되어야 한다");
  });

  test("openai provider 기존 동작 불변 — EMBEDDING_ENABLED=false (키 없음)", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER  : "openai",
        OPENAI_API_KEY      : "",
        EMBEDDING_API_KEY   : "",
        EMBEDDING_BASE_URL  : "",
        GEMINI_API_KEY      : "",
        CF_API_TOKEN        : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_ENABLED) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "false", "키 없는 openai provider는 ENABLED=false여야 한다");
  });

  test("openai provider + API 키 설정 시 EMBEDDING_ENABLED=true", () => {
    const result = runConfigSnippet(
      {
        EMBEDDING_PROVIDER  : "openai",
        OPENAI_API_KEY      : "sk-test",
        EMBEDDING_API_KEY   : "",
        EMBEDDING_BASE_URL  : "",
        GEMINI_API_KEY      : "",
        CF_API_TOKEN        : "",
        CLOUDFLARE_API_TOKEN: "",
        DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: ""
      },
      `process.stdout.write(String(cfg.EMBEDDING_ENABLED) + "\\n");`
    );
    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, "true", "키 있는 openai provider는 ENABLED=true여야 한다");
  });
});
