import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { ReflectProcessor } from "../../lib/memory/ReflectProcessor.js";

describe("ReflectProcessor episode 저장", () => {
  test("narrative episode remember는 skipConflictDetection=true로 호출된다", async () => {
    const rememberCalls = [];
    const proc = new ReflectProcessor({
      store: { insert: async () => "id", },
      index: { index: async () => {}, clearWorkingMemory: async () => {} },
      factory: { create: (p) => ({ ...p, keywords: [] }), splitAndCreate: () => [] },
      sessionLinker: {
        consolidateSessionFragments: async () => null,
        autoLinkSessionFragments: async () => ({ linkSuggestions: [] }),
      },
      remember: async (p) => { rememberCalls.push(p); return { id: "frag-ep" }; },
      batchRememberProcessor: {
        process: async ({ fragments }) => ({
          results: fragments.map((_, i) => ({ success: true, id: `frag-${i}` })),
        }),
      },
    });

    await proc.process({
      summary: ["요약 1"],
      narrative_summary: "세션 서사 요약",
      sessionId: "sess-test",
    });

    const episodeCall = rememberCalls.find(c => c.type === "episode");
    assert.ok(episodeCall, "episode remember가 호출되어야 한다");
    assert.equal(episodeCall.skipConflictDetection, true);
  });
});
