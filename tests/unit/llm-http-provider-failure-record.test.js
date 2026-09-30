import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { AnthropicProvider }    from "../../lib/llm/providers/AnthropicProvider.js";
import { CohereProvider }       from "../../lib/llm/providers/CohereProvider.js";
import { GoogleGeminiProvider } from "../../lib/llm/providers/GoogleGeminiProvider.js";
import { OllamaProvider }       from "../../lib/llm/providers/OllamaProvider.js";
import { teardownTestResources } from "../_lifecycle.js";

/**
 * HTTP provider 의 실패 기록 횟수와 Gemini 인증 전달 위치 시험.
 * 실제 provider 를 로컬 HTTP 서버에 연결하고 기록 메서드 호출 횟수를 센다.
 */
const CASES = [
  ["anthropic", AnthropicProvider,    "/messages",                         { content: [] }],
  ["cohere",    CohereProvider,       "/chat",                             {}],
  ["google",    GoogleGeminiProvider, "/models/m:generateContent",         { candidates: [] }],
  ["ollama",    OllamaProvider,       "/api/chat",                         { message: {} }]
];

describe("HTTP provider 실패 기록", () => {
  let server;
  let base;
  let mode = "500";
  const seen = [];

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      req.resume();
      req.on("end", () => {
        if (mode === "500") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("boom");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(CASES.find(c => c[2] === req.url.split("?")[0])[3]));
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await teardownTestResources();
  });

  for (const [label, Provider] of CASES) {
    for (const [scenario, expectedMode] of [["HTTP 오류 응답", "500"], ["빈 응답", "empty"]]) {
      it(`${label}: ${scenario} 한 번의 호출은 실패를 한 번 기록한다`, async () => {
        mode = expectedMode;
        const provider = new Provider({ apiKey: "k", baseUrl: base, model: "m" });
        const fail     = mock.method(provider, "recordFailure", async () => {});
        const success  = mock.method(provider, "recordSuccess", async () => {});
        provider.isCircuitOpen = async () => false;
        await assert.rejects(provider.callText("hi", { timeoutMs: 2000 }));
        assert.equal(fail.mock.callCount(), 1);
        assert.equal(success.mock.callCount(), 0);
      });
    }
  }

  it("google: API 키는 URL 쿼리가 아닌 x-goog-api-key 헤더로 전달한다", async () => {
    mode = "500";
    seen.length = 0;
    const provider = new GoogleGeminiProvider({ apiKey: "SECRET-KEY", baseUrl: base, model: "m" });
    provider.recordFailure = async () => {};
    provider.isCircuitOpen = async () => false;
    await assert.rejects(provider.callText("hi", { timeoutMs: 2000 }));
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0].url, /key=|SECRET-KEY/);
    assert.equal(seen[0].headers["x-goog-api-key"], "SECRET-KEY");
  });
});
