/**
 * 스위치 대장 순수 함수 시험
 *
 * describeSwitches가 미설정, 유효 값, 잘못된 값에서 돌려주는 상태와 요약, 기동 로그 줄을 검사한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  SWITCHES,
  describeSwitches,
  summarizeSwitches,
  switchSummaryLine,
  formatSwitchTable
} from "../../config/switches.js";
import { classifyBool, classifyEnum } from "../../lib/env-parse.js";

const byName = (states, name) => states.find((s) => s.name === name);

describe("classifyBool, classifyEnum", () => {
  it("미설정과 공백은 unset이다", () => {
    assert.equal(classifyBool(undefined).status, "unset");
    assert.equal(classifyBool("").status, "unset");
    assert.equal(classifyBool("  ").status, "unset");
    assert.equal(classifyEnum(undefined, ["a"]).status, "unset");
    assert.equal(classifyEnum(" ", ["a"]).status, "unset");
  });

  it("true와 false만 유효한 불리언이다", () => {
    assert.deepEqual(classifyBool("true"),  { status: "valid", value: true });
    assert.deepEqual(classifyBool("false"), { status: "valid", value: false });
    for (const raw of ["TRUE", "1", "yes", " true"]) assert.equal(classifyBool(raw).status, "invalid", raw);
  });

  it("열거는 허용 값과 정확히 같을 때만 유효하다", () => {
    assert.deepEqual(classifyEnum("warn", ["warn", "enforce"]), { status: "valid", value: "warn" });
    assert.equal(classifyEnum("Warn", ["warn", "enforce"]).status, "invalid");
  });
});

describe("describeSwitches 미설정", () => {
  const states = describeSwitches({});

  it("레지스트리의 모든 스위치가 한 번씩 나온다", () => {
    assert.equal(states.length, SWITCHES.length);
    assert.deepEqual(states.map((s) => s.name), SWITCHES.map((s) => s.name));
  });

  it("값은 문서 기본값이고 기본값과 다르지 않다", () => {
    for (const s of states) {
      assert.equal(s.nonDefault, false, s.name);
      assert.equal(s.invalid, false, s.name);
      assert.equal(s.value, s.default, s.name);
    }
  });

  it("기본값이 켜짐인 스위치와 꺼짐인 스위치를 구분한다", () => {
    assert.equal(byName(states, "MEMENTO_API_KEY_DELETE_GUARD").state, "on");
    assert.equal(byName(states, "MEMENTO_WORKSPACE_GATE").state,      "off");
    assert.equal(byName(states, "MEMENTO_ADMIN_AUTH_BACKOFF").state,  "off");
  });

  it("열거의 기본값은 그 문서 값이다", () => {
    assert.equal(byName(states, "MEMENTO_TOOL_ARGS_VALIDATION").value, "warn");
    assert.equal(byName(states, "MEMENTO_CORS_MODE").value,            "observe");
  });

  it("공백만 있는 값은 미설정과 같다", () => {
    const s = byName(describeSwitches({ MEMENTO_WORKSPACE_GATE: "  " }), "MEMENTO_WORKSPACE_GATE");
    assert.equal(s.state, "off");
    assert.equal(s.invalid, false);
  });
});

describe("describeSwitches 유효 값", () => {
  it("기본이 꺼짐인 스위치를 true로 켜면 켜짐이고 기본과 다르다", () => {
    const s = byName(describeSwitches({ MEMENTO_WORKSPACE_GATE: "true" }), "MEMENTO_WORKSPACE_GATE");
    assert.equal(s.state,      "on");
    assert.equal(s.value,      "true");
    assert.equal(s.nonDefault, true);
  });

  it("기본이 켜짐인 스위치를 false로 끄면 꺼짐이고 기본과 다르다", () => {
    const s = byName(describeSwitches({ MEMENTO_API_KEY_DELETE_GUARD: "false" }), "MEMENTO_API_KEY_DELETE_GUARD");
    assert.equal(s.state,      "off");
    assert.equal(s.nonDefault, true);
  });

  it("기본값과 같은 값을 명시하면 기본과 다르지 않다", () => {
    const s = byName(describeSwitches({ MEMENTO_API_KEY_DELETE_GUARD: "true" }), "MEMENTO_API_KEY_DELETE_GUARD");
    assert.equal(s.nonDefault, false);
  });

  it("열거는 허용 값을 그대로 쓰고 꺼짐 값이면 꺼짐이다", () => {
    const strict = byName(describeSwitches({ MEMENTO_TOOL_ARGS_VALIDATION: "enforce" }), "MEMENTO_TOOL_ARGS_VALIDATION");
    assert.equal(strict.value,      "enforce");
    assert.equal(strict.state,      "on");
    assert.equal(strict.nonDefault, true);
    const off = byName(describeSwitches({ MEMENTO_TOOL_ARGS_VALIDATION: "off" }), "MEMENTO_TOOL_ARGS_VALIDATION");
    assert.equal(off.state, "off");
  });

  it("꺼짐 값이 정해지지 않은 열거는 mode로 표시한다", () => {
    const s = byName(describeSwitches({ MEMENTO_CORS_MODE: "allowlist" }), "MEMENTO_CORS_MODE");
    assert.equal(s.state, "mode");
    assert.equal(s.value, "allowlist");
  });

  it("다른 스위치를 따르는 기본값은 그 스위치의 값이다", () => {
    const follow = byName(describeSwitches({ REDIS_ENABLED: "true" }), "CACHE_ENABLED");
    assert.equal(follow.state,      "on");
    assert.equal(follow.nonDefault, false);
    const alone = byName(describeSwitches({ CACHE_ENABLED: "true" }), "CACHE_ENABLED");
    assert.equal(alone.state,      "on");
    assert.equal(alone.nonDefault, true);
    const none = byName(describeSwitches({}), "CACHE_ENABLED");
    assert.equal(none.state, "off");
  });

  it("대소문자를 구분하지 않는 판독기를 쓰는 스위치는 TRUE를 켜짐으로 본다", () => {
    const s = byName(describeSwitches({ MEMENTO_SYMBOLIC_ENABLED: "TRUE" }), "MEMENTO_SYMBOLIC_ENABLED");
    assert.equal(s.state,   "on");
    assert.equal(s.invalid, false);
  });
});

describe("describeSwitches 잘못된 값", () => {
  it("불리언의 잘못된 값은 적용값으로 표시하고 invalid로 표시한다", () => {
    const s = byName(describeSwitches({ MEMENTO_WORKSPACE_GATE: "1" }), "MEMENTO_WORKSPACE_GATE");
    assert.equal(s.invalid,    true);
    assert.equal(s.problem,    "not_boolean");
    assert.equal(s.state,      "off");
    assert.equal(s.value,      "false");
    assert.equal(s.nonDefault, false);
  });

  it("기본이 켜짐인 불리언의 잘못된 값은 켜짐으로 적용된다", () => {
    const s = byName(describeSwitches({ MEMENTO_API_KEY_DELETE_GUARD: "no" }), "MEMENTO_API_KEY_DELETE_GUARD");
    assert.equal(s.invalid, true);
    assert.equal(s.state,   "on");
  });

  it("잘못된 값을 쓰면 꺼짐으로 적용되는 판독기를 따른다", () => {
    const s = byName(describeSwitches({ MEMENTO_FEEDBACK_SAMPLING: "1" }), "MEMENTO_FEEDBACK_SAMPLING");
    assert.equal(s.invalid,    true);
    assert.equal(s.state,      "off");
    assert.equal(s.nonDefault, true);
    const blank = byName(describeSwitches({ MEMENTO_FEEDBACK_SAMPLING: "" }), "MEMENTO_FEEDBACK_SAMPLING");
    assert.equal(blank.invalid, true);
    assert.equal(blank.state,   "off");
  });

  it("열거의 잘못된 값은 판독기가 적용하는 값으로 표시한다", () => {
    const s = byName(describeSwitches({ MEMENTO_TOOL_ARGS_VALIDATION: "strict" }), "MEMENTO_TOOL_ARGS_VALIDATION");
    assert.equal(s.invalid,    true);
    assert.equal(s.problem,    "not_in_enum");
    assert.equal(s.value,      "enforce");
    assert.equal(s.nonDefault, true);
    const cors = byName(describeSwitches({ MEMENTO_CORS_MODE: "Reflect" }), "MEMENTO_CORS_MODE");
    assert.equal(cors.value, "observe");
  });

  it("공백만 있는 MEMENTO_TOOL_ARGS_VALIDATION은 잘못된 값이고 enforce로 적용된다", () => {
    const blank = byName(describeSwitches({ MEMENTO_TOOL_ARGS_VALIDATION: " " }), "MEMENTO_TOOL_ARGS_VALIDATION");
    assert.equal(blank.invalid, true);
    assert.equal(blank.value,   "enforce");
    assert.equal(blank.state,   "on");
    const empty = byName(describeSwitches({ MEMENTO_TOOL_ARGS_VALIDATION: "" }), "MEMENTO_TOOL_ARGS_VALIDATION");
    assert.equal(empty.invalid, false);
    assert.equal(empty.value,   "warn");
  });

  it("닫힌 열거에서 문서 값이 아닌 기본값 표기는 잘못된 값이다", () => {
    const frame = byName(describeSwitches({ MEMENTO_FRAME_OPTIONS: "off" }), "MEMENTO_FRAME_OPTIONS");
    assert.equal(frame.invalid, true);
    assert.equal(frame.value,   "off");
  });

  it("off만 끄는 스위치는 off 외의 모든 값을 켜짐으로 보고 잘못된 값이 없다", () => {
    for (const name of ["MEMENTO_VECTOR_FORCE_INDEX", "MEMENTO_ADMIN_METRICS_SAMPLING", "MEMENTO_METRICS_DEFAULT"]) {
      for (const raw of [undefined, "", " ", "on", "ON", "true", "garbage", " off", "Off"]) {
        const s = byName(describeSwitches(raw === undefined ? {} : { [name]: raw }), name);
        assert.equal(s.invalid, false, `${name} ${JSON.stringify(raw)}`);
        assert.equal(s.state,   "on",  `${name} ${JSON.stringify(raw)}`);
        assert.equal(s.value,   "on",  `${name} ${JSON.stringify(raw)}`);
      }
      const off = byName(describeSwitches({ [name]: "off" }), name);
      assert.equal(off.state,      "off");
      assert.equal(off.invalid,    false);
      assert.equal(off.nonDefault, true);
    }
  });

  it("기동 실패로 이어지는 값은 invalid 상태로 표시한다", () => {
    const s = byName(describeSwitches({ MEMENTO_AUTO_PROMOTE_ANCHORS: "maybe" }), "MEMENTO_AUTO_PROMOTE_ANCHORS");
    assert.equal(s.invalid, true);
    assert.equal(s.state,   "invalid");
  });

  it("잘못된 원본 값은 결과 어디에도 나오지 않는다", () => {
    const secret = "tok_SECRET_value_123";
    const json   = JSON.stringify(describeSwitches({ MEMENTO_WORKSPACE_GATE: secret, MEMENTO_CORS_MODE: secret }));
    assert.ok(!json.includes(secret));
  });

  it("레지스트리에 없는 변수는 결과에 영향을 주지 않는다", () => {
    const base  = JSON.stringify(describeSwitches({}));
    const other = JSON.stringify(describeSwitches({ MEMENTO_ACCESS_KEY: "k", SOME_OTHER: "true" }));
    assert.equal(base, other);
  });

  it("입력 객체를 바꾸지 않는다", () => {
    const env = Object.freeze({ MEMENTO_WORKSPACE_GATE: "true" });
    assert.doesNotThrow(() => describeSwitches(env));
  });
});

describe("summarizeSwitches", () => {
  it("미설정이면 기본과 다른 스위치가 없다", () => {
    const sum = summarizeSwitches({});
    assert.equal(sum.total,           SWITCHES.length);
    assert.equal(sum.nonDefaultCount, 0);
    assert.deepEqual(sum.nonDefault,  []);
    assert.deepEqual(sum.invalid,     []);
    assert.equal(sum.on + sum.off + sum.mode, sum.total);
  });

  it("기본과 다른 스위치 이름과 잘못된 값의 이름을 담는다", () => {
    const sum = summarizeSwitches({
      MEMENTO_WORKSPACE_GATE:      "true",
      MEMENTO_API_KEY_DELETE_GUARD: "false",
      MEMENTO_CORS_MODE:           "bogus"
    });
    assert.deepEqual([...sum.nonDefault].sort(), ["MEMENTO_API_KEY_DELETE_GUARD", "MEMENTO_WORKSPACE_GATE"]);
    assert.equal(sum.nonDefaultCount, 2);
    assert.deepEqual(sum.invalid, ["MEMENTO_CORS_MODE"]);
  });

  it("켜짐과 꺼짐의 개수는 상태와 맞는다", () => {
    const base = summarizeSwitches({});
    const next = summarizeSwitches({ MEMENTO_WORKSPACE_GATE: "true" });
    assert.equal(next.on,  base.on + 1);
    assert.equal(next.off, base.off - 1);
  });
});

describe("switchSummaryLine", () => {
  it("개수와 기본과 다른 스위치의 이름과 켜짐 꺼짐 또는 열거 값만 담는다", () => {
    const line = switchSummaryLine({ MEMENTO_WORKSPACE_GATE: "true", MEMENTO_TOOL_ARGS_VALIDATION: "enforce" });
    assert.ok(line.includes("MEMENTO_WORKSPACE_GATE=on"));
    assert.ok(line.includes("MEMENTO_TOOL_ARGS_VALIDATION=enforce"));
    assert.ok(!line.includes("=true"));
    assert.ok(!line.includes("\n"));
  });

  it("기본과 다른 스위치가 없으면 이름 목록을 붙이지 않는다", () => {
    const line = switchSummaryLine({});
    assert.ok(line.includes("nonDefault=0"));
    assert.ok(!line.includes("MEMENTO_WORKSPACE_GATE"));
  });

  it("잘못된 값이 있으면 그 이름을 적는다", () => {
    const line = switchSummaryLine({ MEMENTO_CORS_MODE: "bogus" });
    assert.ok(line.includes("invalid=1"));
    assert.ok(line.includes("MEMENTO_CORS_MODE"));
    assert.ok(!line.includes("bogus"));
  });
});

describe("formatSwitchTable", () => {
  it("스위치마다 한 줄인 마크다운 표를 만든다", () => {
    const states = describeSwitches({ MEMENTO_WORKSPACE_GATE: "true" });
    const lines  = formatSwitchTable(states).split("\n");
    assert.ok(lines[0].startsWith("| 스위치 |"));
    assert.match(lines[1], /^\|(-\|)+$/);
    assert.equal(lines.length, 2 + SWITCHES.length);
    const row = lines.find((l) => l.startsWith("| MEMENTO_WORKSPACE_GATE |"));
    assert.ok(row.includes("| on |"));
    assert.ok(row.includes("| 예 |"));
  });

  it("잘못된 값은 적용값과 표시를 함께 적고 원본은 적지 않는다", () => {
    const table = formatSwitchTable(describeSwitches({ MEMENTO_WORKSPACE_GATE: "tok_SECRET_1" }));
    assert.ok(!table.includes("tok_SECRET_1"));
    assert.ok(table.includes("값 오류"));
  });
});

describe("레지스트리 항목", () => {
  it("이름이 중복되지 않는다", () => {
    const names = SWITCHES.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("종류, 기본값, 설명, 분류가 갖춰져 있다", () => {
    for (const s of SWITCHES) {
      assert.ok(["boolean", "enum", "off-disables"].includes(s.kind), s.name);
      assert.ok(typeof s.purpose === "string" && s.purpose.length > 0, `${s.name} purpose`);
      assert.ok(typeof s.category === "string" && s.category.length > 0, `${s.name} category`);
      if (s.kind === "boolean") assert.ok(typeof s.default === "boolean" || s.follows, `${s.name} default`);
      else assert.ok(typeof s.default === "string" && Array.isArray(s.values), `${s.name} enum`);
      if (s.kind === "off-disables") assert.deepEqual([s.default, s.off], ["on", ["off"]], s.name);
    }
  });

  it("열거의 꺼짐 값과 잘못된 값 적용값은 그 열거 안에 있다", () => {
    for (const s of SWITCHES.filter((x) => x.kind !== "boolean")) {
      const known = new Set([...s.values, s.default]);
      for (const v of s.off ?? []) assert.ok(known.has(v), `${s.name} off ${v}`);
      if (s.invalid !== undefined) assert.ok(known.has(s.invalid), `${s.name} invalid ${s.invalid}`);
    }
  });

  it("따르는 스위치는 앞에 있는 불리언 스위치다", () => {
    SWITCHES.forEach((s, i) => {
      if (!s.follows) return;
      const at = SWITCHES.findIndex((x) => x.name === s.follows);
      assert.ok(at >= 0 && at < i && SWITCHES[at].kind === "boolean", s.name);
    });
  });

  it("키, 토큰, 비밀번호, 주소를 담는 변수 이름이 없다", () => {
    const secretLike = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_URL|_HOST)$/;
    /** 이름에 KEY가 들어가지만 값이 고정 열거인 방식 선택 스위치 */
    const modeOnly   = new Set(["MEMENTO_SSE_QUERY_KEY"]);
    for (const s of SWITCHES) {
      if (modeOnly.has(s.name)) assert.equal(s.kind, "enum", s.name);
      else assert.ok(!secretLike.test(s.name), s.name);
    }
  });
});
