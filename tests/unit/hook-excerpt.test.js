/**
 * 훅 요약 후보(대화 발췌) 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * transcript JSONL 줄에서 대화 메시지를 꺼내고, 바이트 상한 안에서 최근 메시지로 발췌를 만들고,
 * 발췌에서 마지막 응답 블록을 고르는 함수를 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  extractTranscriptMessages, formatExcerpt, lastAssistantBlock, clipText, EXCERPT_ROLE_MARK
} from "../../lib/hooks/hook-excerpt.js";

const line = (obj) => JSON.stringify(obj);

describe("extractTranscriptMessages", () => {
  it("Claude Code 줄에서 사용자와 응답의 텍스트만 꺼낸다", () => {
    const lines = [
      line({ type: "user", message: { role: "user", content: "배포 스크립트를 고쳐 줘" } }),
      line({ type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "확인했다." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }
      ] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "secret output" }] } }),
      line({ type: "summary", summary: "x" }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "수정을 마쳤다." }] } })
    ];
    assert.deepEqual(extractTranscriptMessages(lines), [
      { role: "user", text: "배포 스크립트를 고쳐 줘" },
      { role: "assistant", text: "확인했다." },
      { role: "assistant", text: "수정을 마쳤다." }
    ]);
  });

  it("Codex 줄의 response_item 메시지를 꺼내고 환경 주입 블록은 뺀다", () => {
    const lines = [
      line({ type: "session_meta", payload: { id: "s" } }),
      line({ type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<environment_context>cwd</environment_context>" }
      ] } }),
      line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "테스트를 돌려 줘" }] } }),
      line({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
      line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "모두 통과했다." }] } }),
      line({ type: "event_msg", payload: { type: "agent_message", message: "모두 통과했다." } })
    ];
    assert.deepEqual(extractTranscriptMessages(lines), [
      { role: "user", text: "테스트를 돌려 줘" },
      { role: "assistant", text: "모두 통과했다." }
    ]);
  });

  it("response_item이 없으면 Codex event_msg 메시지를 쓴다", () => {
    const lines = [
      line({ type: "event_msg", payload: { type: "user_message", message: "질문" } }),
      line({ type: "event_msg", payload: { type: "agent_message", message: "답변" } })
    ];
    assert.deepEqual(extractTranscriptMessages(lines), [{ role: "user", text: "질문" }, { role: "assistant", text: "답변" }]);
  });

  it("깨진 줄, 빈 줄, 객체가 아닌 줄은 건너뛴다", () => {
    assert.deepEqual(extractTranscriptMessages(["", "{broken", "3", "null", line({ type: "user", message: { content: "  " } })]), []);
  });
});

describe("formatExcerpt", () => {
  const messages = [
    { role: "user", text: "첫 질문" },
    { role: "assistant", text: "첫 답" },
    { role: "user", text: "둘째 질문" },
    { role: "assistant", text: "둘째 답" }
  ];

  it("역할 표지 블록을 시간 순으로 잇는다", () => {
    const out = formatExcerpt(messages, 10_000);
    assert.equal(out.split(EXCERPT_ROLE_MARK.assistant).length - 1, 2);
    assert.ok(out.indexOf("첫 질문") < out.indexOf("둘째 답"));
    assert.ok(out.endsWith("둘째 답"));
  });

  it("상한 안에서 최근 메시지를 남기고 오래된 것부터 버린다", () => {
    const out = formatExcerpt(messages, Buffer.byteLength(`${EXCERPT_ROLE_MARK.user}\n둘째 질문\n\n${EXCERPT_ROLE_MARK.assistant}\n둘째 답`));
    assert.ok(!out.includes("첫"));
    assert.ok(out.includes("둘째 질문") && out.includes("둘째 답"));
  });

  it("가장 최근 메시지 하나가 상한을 넘으면 그 끝부분을 문자 경계에서 자른다", () => {
    const big = { role: "assistant", text: "가".repeat(1000) + "끝" };
    const out = formatExcerpt([big], 300);
    assert.ok(Buffer.byteLength(out, "utf8") <= 300);
    assert.ok(out.endsWith("끝"));
    assert.ok(!out.includes("�"));
    assert.ok(out.startsWith(EXCERPT_ROLE_MARK.assistant));
  });

  it("메시지가 없으면 빈 문자열이다", () => {
    assert.equal(formatExcerpt([], 100), "");
  });
});

describe("lastAssistantBlock", () => {
  it("마지막 응답 블록의 본문을 돌려준다", () => {
    const excerpt = formatExcerpt([
      { role: "assistant", text: "중간 답" }, { role: "user", text: "다음" }, { role: "assistant", text: "최종 정리" }
    ], 10_000);
    assert.equal(lastAssistantBlock(excerpt), "최종 정리");
  });

  it("응답 블록이 없으면 발췌 끝부분을 쓴다", () => {
    assert.equal(lastAssistantBlock("그냥 텍스트"), "그냥 텍스트");
    assert.equal(lastAssistantBlock(`${EXCERPT_ROLE_MARK.user}\n질문만`), "질문만");
  });
});

describe("clipText", () => {
  it("공백을 접고 상한 문자 수 안에서 단어 경계로 자른다", () => {
    assert.equal(clipText("a  b\n\nc", 10), "a b c");
    const clipped = clipText("alpha beta gamma delta", 12);
    assert.ok(clipped.length <= 12);
    assert.equal(clipped, "alpha beta");
    assert.equal(clipText("x".repeat(20), 5), "xxxxx");
  });
});
