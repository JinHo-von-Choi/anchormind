import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchWithTimeout } from "../../lib/llm/util/fetch-with-timeout.js";
import { LlmTimeoutError } from "../../lib/llm/errors.js";

/**
 * fetchWithTimeout 동작 시험.
 * 실제 로컬 HTTP 서버로 무응답과 본문 정지를 만들어 오류 메시지와 타이머 범위를 확인한다.
 */
describe("fetchWithTimeout", () => {
  let server;
  let base;
  const sockets = new Set();

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/silent")) return;
      if (req.url.startsWith("/stall-body")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  it("타임아웃 오류의 메시지와 url 에 쿼리 문자열이 들어가지 않는다", async () => {
    await assert.rejects(
      fetchWithTimeout(`${base}/silent?key=SECRET`, {}, 50),
      (err) => {
        assert.ok(err instanceof LlmTimeoutError);
        assert.doesNotMatch(err.message, /SECRET/);
        assert.doesNotMatch(String(err.url), /SECRET/);
        return true;
      }
    );
  });

  it("헤더 수신 뒤 본문이 멈추면 타임아웃 안에 거부된다", async () => {
    const res  = await fetchWithTimeout(`${base}/stall-body`, {}, 200);
    const gate = new Promise((_, reject) => setTimeout(() => reject(new Error("본문 읽기가 타임아웃 안에 끝나지 않음")), 1500));
    await assert.rejects(Promise.race([res.text(), gate]), LlmTimeoutError);
  });

  it("정상 응답은 본문을 그대로 돌려준다", async () => {
    const res = await fetchWithTimeout(`${base}/ok`, {}, 1000);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
