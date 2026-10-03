/**
 * SensitiveScanner 규칙 표 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 규칙마다 양성 표본과 음성 표본, 합성 비밀 재현율, 코드 식별자 오탐률, 대체 문자열의 재탐지 없음,
 * 필드 단위 검사, 적대적 입력의 시간 상한을 순수 함수로 확인한다. 표본은 모두 합성 값이다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { scanText, maskText, scanFields, SCANNED_TEXT_FIELDS } from "../../lib/security/SensitiveScanner.js";
import { SENSITIVE_PATTERNS, patternsFor, luhnValid, rrnChecksumValid, createRrnValidator } from "../../lib/security/sensitivePatterns.js";
import { keywordText } from "../../lib/memory/write/FragmentFactory.js";

const rep = (ch, n) => ch.repeat(n);

/** 앞 12자리로 검증 자릿수를 계산해 13자리 주민등록번호 숫자열을 만든다. */
function rrnDigits(first12) {
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum     = [...first12].reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  return `${first12}${(11 - (sum % 11)) % 10}`;
}

/** 13자리 연속 숫자 중 Luhn과 EAN-13 검증 자릿수가 모두 맞는 값을 찾는다. */
function luhnAndEan13() {
  const ean = (d) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === Number(d[12]);
  };
  for (let n = 0; n < 100000; n++) {
    const candidate = `40${String(n).padStart(11, "0")}`;
    if (luhnValid(candidate) && ean(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/** 접두를 주면 길이 n에서 Luhn이 맞는 숫자열을 만든다. */
function luhnNumber(prefix, length) {
  const body = prefix + rep("1", length - prefix.length - 1);
  for (let check = 0; check <= 9; check++) {
    if (luhnValid(`${body}${check}`)) return `${body}${check}`;
  }
  throw new Error("unreachable");
}

const ids = (text, options) => scanText(text, options).rules.map((r) => r.id);

/** 규칙 이름과 합성 표본. 접두는 조립해 소스에 실제 형태의 토큰이 통째로 남지 않게 한다. */
const POSITIVE = {
  api_key_legacy: [`sk-${rep("a", 40)}`, `sk-${rep("Z9", 20)}`, `AIza${rep("x", 35)}`],
  anthropic_key: [
    `sk-ant-api03-${rep("A1b2", 20)}`,
    `sk-ant-${rep("x", 30)}`,
    `sk-ant-admin01-${rep("Q_-", 12)}`,
    `key=sk-ant-api03-${rep("z", 24)}AA`
  ],
  openai_project_key: [`sk-proj-${rep("a1B2", 14)}`, `sk-proj-${rep("T", 20)}_x-y`, `sk-proj-${rep("9", 40)}`],
  api_key_generic: [`sk-svcacct-${rep("a1B2", 12)}`, `sk-admin-${rep("z9", 20)}-t3`, `sk-None-${rep("k7Q2", 10)}`],
  github_token: [
    `ghp_${rep("a1", 18)}`, `gho_${rep("B2", 18)}`, `ghu_${rep("c3", 18)}`, `ghs_${rep("D4", 18)}`,
    `github_pat_${rep("e5F6", 8)}_${rep("g7", 12)}`, `github_pat_${rep("H8", 15)}`
  ],
  aws_access_key: [`AKIA${rep("A1", 8)}`, `ASIA${rep("Z9", 8)}`, `AKIAIOSFODNN7EXAMPLE`, `ASIA${rep("Q", 16)}`],
  slack_token: [`xoxb-${rep("1", 12)}-${rep("2", 13)}-${rep("aB", 12)}`, `xoxp-${rep("3", 12)}-${rep("c", 20)}`, `xoxa-2-${rep("9", 14)}`],
  jwt: [
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rep("s", 22)}`,
    `eyJ${rep("a", 10)}.eyJ${rep("b", 10)}.${rep("c_-", 8)}`,
    `eyJ0eXAiOiJKV1QifQ.eyJpc3MiOiJ4In0.${rep("Z", 12)}`
  ],
  private_key: [
    `-----BEGIN RSA PRIVATE KEY-----\n${rep("MIIE", 20)}\n-----END RSA PRIVATE KEY-----`,
    `-----BEGIN EC PRIVATE KEY-----\n${rep("AbCd", 15)}\n-----END EC PRIVATE KEY-----`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${rep("b3Bl", 20)}\n-----END OPENSSH PRIVATE KEY-----`,
    `-----BEGIN PRIVATE KEY-----\n${rep("MIIv", 20)}\n-----END PRIVATE KEY-----`,
    `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${rep("QwEr", 20)}\n-----END ENCRYPTED PRIVATE KEY-----`,
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${rep("lQdG", 20)}\n-----END PGP PRIVATE KEY BLOCK-----`,
    `-----BEGIN PRIVATE KEY-----\n${rep("MIIv", 20)}`
  ],
  mmcp_key: [`mmcp_${rep("a", 8)}_${rep("0f", 16)}`, `mmcp_team_${rep("9a", 16)}`, `api_key=mmcp_${rep("Ab1", 10)}`],
  bearer_token: [
    `Bearer ${rep("a1", 12)}`, `Bearer\t${rep("Zz9", 10)}.${rep("q", 8)}`, `header Bearer ${rep("k7", 20)}==`
  ],
  rrn_kr: [
    rrnDigits("850315223456"), `${rrnDigits("850315223456").slice(0, 6)}-${rrnDigits("850315223456").slice(6)}`,
    `${rrnDigits("920722145678").slice(0, 6)}-${rrnDigits("920722145678").slice(6)}`, "250315-4234567", "201001-3123456"
  ],
  card_number: [
    "카드 4111111111111111", "4111 1111 1111 1111", "5555-5555-5555-4444", `card: ${luhnNumber("37", 15)}`,
    "3782 822463 10005", `visa ${luhnNumber("65", 16)} amex`, `신용 ${luhnNumber("35", 16)}`, `${luhnNumber("2223", 16)} mastercard`, `cvv ${luhnNumber("62", 19)}`
  ],
  url_credentials: [
    `postgres://admin:p#ss!w@db.example.com:5432/app`, `mysql://root:${rep("Zx9", 4)}@192.0.2.10:3306/db`,
    `redis://default:pa@ss${rep("7", 6)}@cache.example.net:6379`, `https://deploy:tok${rep("Q1", 8)}@git.example.org/repo.git`
  ],
  stripe_key: [`sk_live_${rep("a1B2", 6)}`, `rk_test_${rep("Z9y8", 5)}`, `sk_test_${rep("q", 24)}`],
  gitlab_token: [`glpat-${rep("x1Y2z3", 4)}`, `gldt-${rep("A_b-", 6)}`, `glrt-${rep("9", 22)}`],
  npm_token: [`npm_${rep("a1B2c3", 6)}`, `NPM_TOKEN npm_${rep("Zz09", 9)}`],
  aws_secret_key: [
    `aws_secret_access_key=${rep("wJalrXUt", 5)}`, `AWS_SECRET_ACCESS_KEY = "${rep("K7MDENG/", 5)}"`,
    `SecretAccessKey: ${rep("bPxR+", 8)}`
  ],
  secret_assignment: [
    "OPENAI_API_KEY=abc123def456", "export GITHUB_TOKEN=supersecretvalue123", "client_secret: 9f8e7d6c5b4a",
    `SECRET_KEY_BASE=${rep("abcdefgh", 3)}`, "\"refresh_token\": \"r1-abcdef-998877\"", "AUTH_TOKEN='Tr0ub4dor&3x'"
  ],
  email: ["ops-team@example.com", "a.b+c@sub.example.co.kr"],
  password_field: ["password: hunter2", "비밀번호=abc123!", "PWD : s3cret"],
  phone_kr: ["010-1234-5678", "01012345678", "011 123 4567"]
};

/** 규칙이 일치하면 안 되는 음성 표본 */
const NEGATIVE = {
  anthropic_key: ["sk-ant-short", "sk-ant-abc123def456", "ask-ant"],
  openai_project_key: ["sk-proj-abc", "sk-proj-"],
  api_key_generic: ["task-queue-processor-worker-name-long-label", "disk-usage-monitor-dashboard-widget-component", "sk-learn"],
  github_token: ["ghp_short", `ghp_${rep("a", 20)}`, "github_pat_short", "gh_token"],
  aws_access_key: [`AKIA${rep("A", 15)}`, `AKIAIOSFODNN7EXAMPLE1`, `MAKIAIOSFODNN7EXAMPLE`, "ASIA_PACIFIC_REGION_CONFIG"],
  slack_token: ["xoxb-1", "xoxo xoxo", "xoxp-short"],
  jwt: ["eyJabc", "eyJhbGciOiJIUzI1NiJ9.payload", `xeyJ${rep("a", 10)}.${rep("b", 10)}.${rep("c", 10)}`, "eyJ.eyJ.eyJ"],
  private_key: [
    `-----BEGIN PUBLIC KEY-----\n${rep("MIIB", 20)}\n-----END PUBLIC KEY-----`,
    `-----BEGIN CERTIFICATE-----\n${rep("MIIC", 20)}\n-----END CERTIFICATE-----`,
    "PRIVATE KEY 파일 경로는 /etc/ssl/private 이다",
    "-----BEGIN PRIVATE KEY----- 헤더로 시작한다는 점을 문서에 적는다. 이후 설정 단계 3개가 남는다.",
    "-----BEGIN RSA PRIVATE KEY----- then continue with the following configuration steps and verify the result",
    `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`
  ],
  mmcp_key: ["mmcp_session", "mmcp_server_config", "mmcp_session=abcdef", "emmcp_" + rep("a", 24)],
  bearer_token: ["Bearer token", "Bearer authentication-scheme-implementation", "BearerTokenFilter", "Bearer short1"],
  rrn_kr: [
    "123456-1234567",
    "850315-1234567",
    "850315-4234567",
    "250315-1234560",
    "200930-3123456",
    "110111-1234567",
    "220101-1234567",
    "8503151234567",
    "2503153234567",
    `${rrnDigits("850315223456")}0`,
    "20230101-1234567",
    "900101-9234567",
    "991341-1234567"
  ],
  card_number: [
    "4111111111111112", "1700000000000", "0000000000000000", rep("4", 20), "1234 5678 9012 3456", "9999999999999995",
    "4111111111111111", "주문번호 4111111111111111 접수", `결제 ${luhnAndEan13()}`, "카드 8801234567890", `${rep("a", 40)} 4111111111111111`
  ],
  url_credentials: ["http://localhost:57332/mcp", "https://user@example.com/path", "ssh://git@host.example.com:22/repo", "postgres://db.example.com/app"],
  stripe_key: ["sk_learn_pipeline_model", "pk_live_" + rep("a1", 12), "sk_live_short"],
  gitlab_token: ["glpat-short", "glpat_" + rep("a", 24), "my-glpat-config"],
  npm_token: ["npm_install_script", "npm_" + rep("a", 20), "npm_" + rep("b1", 20)],
  aws_secret_key: [`aws_secret_access_key=${rep("a", 20)}`, "aws_secret_access_key=${AWS_SECRET}", "SecretAccessKeyLoader"],
  secret_assignment: ["tokenBudget=2000", "API_KEY=${API_KEY}", "max_tokens=4096", "token=short", "password_policy_validator",
    "SECRET_KEY=<your-secret>", "access_token=[REDACTED_TOKEN]"],
  email: ["user@localhost", "@example.com", "name@", "no-at-sign.example.com"],
  password_field: ["password", "passwords are rotated", "비밀번호 정책"],
  phone_kr: ["02-1234-5678", "0101234", "1010-12"]
};

describe("규칙 표 구조", () => {
  it("규칙 이름이 겹치지 않고 저장 경로 패턴이 전역 정규식이거나 apply 구현이다", () => {
    const names = SENSITIVE_PATTERNS.map((e) => e.id);
    assert.equal(new Set(names).size, names.length);
    for (const entry of SENSITIVE_PATTERNS) {
      assert.equal(entry.pattern === null, typeof entry.apply === "function", `${entry.id}: 패턴과 apply는 둘 중 하나만 둔다`);
      if (entry.store !== null && entry.pattern) assert.ok(entry.pattern.global, `${entry.id}은 전역 정규식이어야 한다`);
      assert.ok(entry.severity === "high" || entry.severity === "low", entry.id);
    }
  });

  it("로그 경로 규칙은 검증 함수와 대체 구현 없이 문자열 대체 값만 쓴다", () => {
    for (const entry of patternsFor("log")) {
      assert.equal(typeof entry.log, "string", entry.id);
      assert.equal(entry.validate, undefined, entry.id);
      assert.equal(entry.apply, undefined, entry.id);
    }
  });

  it("저장 경로는 URL 자격 증명 규칙 다음에 레거시 규칙이 온다", () => {
    const store = patternsFor("store").map((e) => e.id);
    assert.deepEqual(store.slice(0, 5), ["url_credentials", "api_key_legacy", "email", "password_field", "phone_kr"]);
    assert.deepEqual(SENSITIVE_PATTERNS.filter((e) => e.legacy).map((e) => e.id), store.slice(1, 5));
  });

  it("URL 자격 증명 규칙이 이메일 규칙보다 먼저 적용되어 비밀번호 앞부분이 남지 않는다", () => {
    const out = maskText("postgres://admin:p#ss!w@db.example.com:5432/app");
    assert.equal(out, "postgres://admin:[REDACTED_PWD]@db.example.com:5432/app");
  });

  it("비밀 이름 대입식은 이름과 구분자를 남기고 값만 가리며 다른 규칙이 가린 값은 다시 세지 않는다", () => {
    assert.equal(maskText("export OPENAI_API_KEY=abc123def456"), "export OPENAI_API_KEY=[REDACTED_SECRET]");
    const ids = scanText(`api_key=mmcp_${rep("Ab1", 10)}`).rules.map((r) => r.id);
    assert.deepEqual(ids, ["mmcp_key"]);
  });

  it("양성과 음성 표본이 저장 경로의 모든 규칙을 덮는다", () => {
    for (const entry of patternsFor("store")) {
      assert.ok(POSITIVE[entry.id]?.length >= 2, `${entry.id} 양성 표본`);
      if (entry.id !== "api_key_legacy") assert.ok(NEGATIVE[entry.id]?.length >= 2, `${entry.id} 음성 표본`);
    }
  });
});

describe("규칙별 양성 표본", () => {
  for (const [id, samples] of Object.entries(POSITIVE)) {
    for (const sample of samples) {
      it(`${id}: ${sample.slice(0, 24).replace(/\n/g, " ")} 계열 표본을 가린다`, () => {
        const result = scanText(`앞 문장 ${sample} 뒤 문장`);
        assert.ok(result.rules.some((r) => r.id === id), `${id}가 일치하지 않았다: ${JSON.stringify(result.rules)}`);
      });
    }
  }

  it("가린 결과에 원문 표본이 남지 않고 표식이 들어간다", () => {
    for (const samples of Object.values(POSITIVE)) {
      for (const sample of samples) {
        const out = maskText(`x ${sample} y`);
        assert.ok(!out.includes(sample), sample.slice(0, 20));
        assert.ok(out.includes("REDACTED"), sample.slice(0, 20));
      }
    }
  });

  it("전화번호 규칙과 겹치는 숫자열도 원문 숫자가 남지 않는다", () => {
    const rrn  = rrnDigits("900101123456");
    const card = "6011 0009 9013 9424";
    assert.ok(!maskText(`번호 ${rrn} 끝`).includes(rrn.slice(3)));
    assert.ok(!maskText(`카드 ${card} 끝`).includes("9013"));
  });
});

describe("규칙별 음성 표본", () => {
  for (const [id, samples] of Object.entries(NEGATIVE)) {
    for (const sample of samples) {
      it(`${id}: ${sample.slice(0, 30).replace(/\n/g, " ")} 은 해당 규칙으로 가리지 않는다`, () => {
        assert.ok(!ids(`앞 ${sample} 뒤`).includes(id), `${id}가 잘못 일치했다`);
      });
    }
  }
});

describe("레거시 규칙의 결과", () => {
  it("이메일, 비밀번호, 전화번호, API 키를 이전과 같은 표식으로 바꾼다", () => {
    const text = `메일 ops@example.com, password: hunter2, 전화 010-1234-5678, 키 sk-${rep("a", 40)} 끝`;
    const out  = maskText(text);
    assert.ok(out.includes("[REDACTED_EMAIL]"));
    assert.ok(out.includes("password: [REDACTED_PWD]"));
    assert.ok(out.includes("[REDACTED_PHONE]"));
    assert.ok(out.includes("[REDACTED_API_KEY]"));
    assert.ok(!/ops@example|hunter2|1234-5678|aaaaaaaaaaaaaaaa/.test(out));
  });

  it("비밀번호 표식은 입력의 키워드 표기(대소문자, 한글)를 그대로 쓴다", () => {
    assert.ok(maskText("PWD = abc").includes("PWD: [REDACTED_PWD]"));
    assert.ok(maskText("비밀번호: 가나다1").includes("비밀번호: [REDACTED_PWD]"));
  });

  it("연달아 붙은 이메일을 모두 가리고 앞뒤 문자를 보존한다", () => {
    const out = maskText("a@b.cc1x@y.zz 와 <u@v.org>, (k.l@m.net)");
    assert.ok(!/@/.test(out), out);
    assert.ok(out.includes("<[REDACTED_EMAIL]>") && out.includes("([REDACTED_EMAIL])"));
  });

  it("legacyOnly 옵션은 레거시 규칙만 적용한다", () => {
    const text = `ops@example.com ${`ghp_${rep("a1", 18)}`}`;
    const out  = scanText(text, { legacyOnly: true });
    assert.deepEqual(out.rules.map((r) => r.id), ["email"]);
    assert.ok(out.text.includes("ghp_"));
  });
});

describe("재탐지와 필드 검사", () => {
  it("가린 결과를 다시 검사하면 일치가 없다", () => {
    const seen = new Set();
    for (const sample of Object.values(POSITIVE).flat()) {
      const once = scanText(`값 ${sample} 끝`);
      once.rules.forEach((r) => seen.add(r.id));
      assert.deepEqual(scanText(once.text).rules, [], sample.slice(0, 20));
      assert.equal(maskText(once.text), once.text);
    }
    assert.ok(seen.size >= 15, `${seen.size}개 규칙`);
  });

  it("비문자열과 빈 문자열은 그대로 돌려준다", () => {
    assert.equal(scanText("").text, "");
    assert.equal(scanText(null).text, null);
    assert.deepEqual(scanText(42).rules, []);
  });

  it("본문 필드 전체와 키워드 배열을 검사하고 규칙과 필드 이름만 보고한다", () => {
    const token  = `ghp_${rep("a1", 18)}`;
    const fields = {
      content       : `토큰 ${token} 를 쓴다`,
      topic         : "plain-topic",
      contextSummary: "연락 ops@example.com",
      goal          : `sk-ant-api03-${rep("A1b2", 20)}`,
      outcome       : `Bearer ${rep("a1", 12)}`,
      keywords      : ["deploy", token, "AKIA" + rep("A1", 8)],
      type          : "fact"
    };
    const { fields: next, findings } = scanFields(fields, SCANNED_TEXT_FIELDS.create);

    assert.ok(!next.content.includes(token));
    assert.ok(!next.contextSummary.includes("ops@example.com"));
    assert.ok(!next.goal.includes("sk-ant"));
    assert.ok(!next.outcome.includes("a1a1a1"));
    assert.equal(next.keywords[0], "deploy");
    assert.ok(next.keywords.slice(1).every((k) => k.includes("REDACTED")));
    assert.equal(next.topic, "plain-topic");
    assert.equal(next.type, "fact");
    assert.equal(fields.content.includes(token), true, "입력 객체는 바뀌지 않는다");

    const github = findings.find((f) => f.rule === "github_token");
    assert.deepEqual(github.fields.sort(), ["content", "keywords"]);
    for (const finding of findings) {
      assert.deepEqual(Object.keys(finding).sort(), ["fields", "rule", "severity"]);
      assert.ok(!JSON.stringify(finding).includes(token));
    }
  });

  it("갱신 열 이름(context_summary)도 검사한다", () => {
    const { fields, findings } = scanFields({ context_summary: "ops@example.com" }, SCANNED_TEXT_FIELDS.update);
    assert.ok(fields.context_summary.includes("[REDACTED_EMAIL]"));
    assert.deepEqual(findings.map((f) => f.rule), ["email"]);
  });

  it("바뀐 값이 없으면 입력 객체를 그대로 돌려준다", () => {
    const fields = { content: "민감하지 않은 평범한 본문", keywords: ["a", "b"] };
    const out    = scanFields(fields, SCANNED_TEXT_FIELDS.create);
    assert.equal(out.fields, fields);
    assert.deepEqual(out.findings, []);
  });

  it("대소문자 무시 판은 JWT 접두를 찾고 AWS 키 규칙은 대문자만 일치시킨다", () => {
    const jwt = `eyJ${rep("a", 10)}.eyJ${rep("b", 10)}.${rep("c", 10)}`.toLowerCase();
    const { findings } = scanFields({ keywords: [jwt, ("AKIA" + rep("A1", 8)).toLowerCase(), "asiapacificoperation", "ASIAPACIFIC-OPERATION"] }, []);
    assert.deepEqual(findings.map((f) => f.rule), ["jwt"]);
    assert.deepEqual(scanText("AKIA" + rep("A1", 8)).rules.map((r) => r.id), ["aws_access_key"]);
    assert.deepEqual(scanText("asiapacificoperation ASIAPACIFIC_OPERATION").rules, []);
  });

  it("foldCaseArrays를 끄면 키워드 항목을 대소문자 구분으로 찾는다", () => {
    const keys = ["AKIA" + rep("A1", 8)];
    assert.equal(scanFields({ keywords: keys }, [], { foldCaseArrays: false }).findings[0].rule, "aws_access_key");
    assert.equal(scanFields({ keywords: [keys[0].toLowerCase()] }, [], { foldCaseArrays: false }).findings.length, 0);
  });

  it("소문자로 다시 보낸 표식은 재탐지되지 않는다", () => {
    assert.deepEqual(scanText("password: [redacted_pwd]").rules, []);
    assert.deepEqual(scanText("PASSWORD=[REDACTED_PWD]").rules, []);
    assert.deepEqual(scanText("password: hunter2").rules.map((r) => r.id), ["password_field"]);
  });
});

describe("PEM 개인 키 규칙", () => {
  const body = (lines, width = 64) => Array.from({ length: lines }, (_, i) => rep(String.fromCharCode(65 + (i % 26)), width)).join("\n");

  it("머리말만 언급한 글은 가리지 않고 뒤 문장을 보존한다", () => {
    for (const text of [
      "문서에는 -----BEGIN PRIVATE KEY----- 머리말로 시작한다고 적는다. 이후 설정 단계 3개가 남는다.",
      "note: -----BEGIN RSA PRIVATE KEY-----\nthis is only an example header\nand the rest of the note continues here",
      "-----BEGIN PRIVATE KEY-----"
    ]) {
      assert.deepEqual(scanText(text).rules, [], text);
      assert.equal(maskText(text), text);
    }
  });

  it("닫는 표지까지 있는 키를 가리고 앞뒤 글을 보존한다", () => {
    for (const eol of ["\n", "\r\n", "\\n"]) {
      const pem = `-----BEGIN RSA PRIVATE KEY-----${eol}${body(3).split("\n").join(eol)}${eol}-----END RSA PRIVATE KEY-----`;
      const out = maskText(`앞 문장 ${pem} 뒤 문장`);
      assert.equal(out, "앞 문장 [REDACTED_PRIVATE_KEY] 뒤 문장", JSON.stringify(eol));
    }
  });

  it("닫는 표지가 없는 키는 머리말과 base64 줄만 가리고 첫 비 base64 줄에서 멈춘다", () => {
    const text = `설정 메모\n-----BEGIN PRIVATE KEY-----\n${body(2)}\n\n이 뒤의 메모는 유지한다: 단계 1, 단계 2\n마지막 줄`;
    const out  = maskText(text);
    assert.ok(out.startsWith("설정 메모\n[REDACTED_PRIVATE_KEY]"), out);
    assert.ok(out.includes("이 뒤의 메모는 유지한다: 단계 1, 단계 2\n마지막 줄"), out);
    assert.ok(!out.includes(rep("A", 64)) && !out.includes("BEGIN"));
  });

  it("줄바꿈이 공백으로 바뀐 한 줄 키를 가리고 뒤 문장을 보존한다", () => {
    const tokens = [rep("M", 64), rep("b", 64), rep("Q", 20)];
    const flat   = `-----BEGIN RSA PRIVATE KEY----- ${tokens.slice(0, 2).join(" ")} ${tokens[2]} -----END RSA PRIVATE KEY-----`;
    assert.equal(maskText(`앞 문장 ${flat} 뒤 문장`), "앞 문장 [REDACTED_PRIVATE_KEY] 뒤 문장");

    const open = `-----BEGIN PRIVATE KEY----- ${tokens[0]} ${tokens[1]} and then normal words follow here`;
    assert.equal(maskText(open), "[REDACTED_PRIVATE_KEY] and then normal words follow here");

    const tabbed = `-----BEGIN PRIVATE KEY-----\t${tokens[0]}\t${tokens[1]}\t-----END PRIVATE KEY-----`;
    assert.equal(maskText(tabbed), "[REDACTED_PRIVATE_KEY]");
  });

  it("머리말 뒤에 일반 단어가 이어지는 설명은 공백이 있어도 가리지 않는다", () => {
    for (const text of [
      "-----BEGIN PRIVATE KEY----- is the header line of a PEM file and the rest of the note continues",
      "Use -----BEGIN RSA PRIVATE KEY----- header then base64 lines follow in the file with the key material",
      `-----BEGIN PRIVATE KEY----- ${rep("A", 30)} ${rep("B", 30)}`,
      "-----BEGIN PRIVATE KEY----- 머리말 설명 이후 단계 3개"
    ]) {
      assert.deepEqual(scanText(text).rules, [], text);
      assert.equal(maskText(text), text);
    }
  });

  it("키 본문이 base64 40자 미만이면 가리지 않는다", () => {
    const text = `-----BEGIN PRIVATE KEY-----\n${rep("A", 39)}\n-----END PRIVATE KEY-----`;
    assert.deepEqual(scanText(text).rules, []);
    assert.deepEqual(scanText(`-----BEGIN PRIVATE KEY-----\n${rep("A", 40)}`).rules.map((r) => r.id), ["private_key"]);
  });

  it("암호화된 키의 머리 줄을 건너뛰고 본문을 가린다", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123ABCD\n\n${body(2)}\n-----END RSA PRIVATE KEY-----`;
    assert.equal(maskText(`x ${pem} y`), "x [REDACTED_PRIVATE_KEY] y");
  });
});

describe("주민등록번호 규칙의 날짜 상한", () => {
  const at        = (iso) => createRrnValidator(() => new Date(iso));
  const noChecksum = (born, gender = 3) => `${born}-${gender}123456`;

  it("성별 자리 3의 번호는 생년월일이 오늘과 어제이면 가리고 내일이면 가리지 않는다", () => {
    const valid = at("2026-10-03T12:00:00");
    assert.equal(rrnChecksumValid(noChecksum("261003").replace("-", "")), false);
    assert.equal(valid(noChecksum("261003")), true, "오늘");
    assert.equal(valid(noChecksum("261002")), true, "어제");
    assert.equal(valid(noChecksum("261004")), false, "내일");
    assert.equal(valid(noChecksum("261004", 4)), false, "내일, 성별 4");
  });

  it("2020-10-01 이전 생년월일과 성별 1, 2, 하이픈 없는 형식은 검증 자릿수가 없으면 가리지 않는다", () => {
    const valid = at("2026-10-03T12:00:00");
    assert.equal(valid(noChecksum("200930")), false);
    assert.equal(valid(noChecksum("201001")), true);
    assert.equal(valid(noChecksum("250315", 1)), false);
    assert.equal(valid(noChecksum("250315").replace("-", "")), false);
  });

  it("검증 자릿수가 맞으면 날짜와 무관하게 가린다", () => {
    const valid = at("2026-10-03T12:00:00");
    const digits = rrnDigits("990101123456");
    assert.equal(valid(`${digits.slice(0, 6)}-${digits.slice(6)}`), true);
  });

  it("시계를 넘기면 해가 바뀐 뒤의 오늘 기준으로 판정한다", () => {
    assert.equal(at("2031-01-01T00:00:00")(noChecksum("301231", 4)), true);
    assert.equal(at("2029-12-31T00:00:00")(noChecksum("301231", 4)), false);
  });
});

describe("키워드 문자열 변환", () => {
  it("keywordText는 문자열과 유한한 숫자를 문자열로 바꾸고 그 밖의 값은 그대로 둔다", () => {
    assert.equal(keywordText("A"), "A");
    assert.equal(keywordText(8503152345678), "8503152345678");
    assert.equal(keywordText(1.5), "1.5");
    for (const junk of [true, null, undefined, {}, ["x"], NaN, Infinity]) assert.equal(keywordText(junk), junk);
  });

  it("숫자 키워드도 문자열과 같이 검사한다", () => {
    const rrn = rrnDigits("850315234567");
    const out = scanFields({ keywords: [rrn, Number(rrn), true, null, { a: 1 }, ["n"]].map(keywordText) }, []);
    assert.equal(out.findings[0].rule, "rrn_kr");
    assert.deepEqual(out.fields.keywords.slice(0, 2), ["[REDACTED_RRN]", "[REDACTED_RRN]"]);
    assert.deepEqual(out.fields.keywords.slice(2), [true, null, { a: 1 }, ["n"]]);
  });
});

describe("카드 번호 규칙의 문맥과 바코드", () => {
  const card = "4111111111111111";

  it("구분자 없는 숫자열은 앞뒤 24자 안에 카드 단어가 있을 때만 가린다", () => {
    assert.deepEqual(scanText(`영수증 번호 ${card} 끝`).rules, []);
    for (const text of [`card ${card}`, `${card} visa`, `신용 ${card}`, `체크카드 ${card}`, `${card} 카드`, `MasterCard: ${card}`, `amex ${card}`, `${card}, cvc 123`, `${card} cvv`]) {
      assert.deepEqual(scanText(text).rules.map((r) => r.id), ["card_number"], text);
    }
    for (const text of [`결제 수단 ${card}`, `승인 번호 ${card}`, `master 계정 ${card}`, `결제 승인 ${card} 완료`]) {
      assert.deepEqual(scanText(text).rules, [], text);
    }
    assert.deepEqual(scanText(`카드${rep("가", 30)} ${card}`).rules, []);
  });

  it("구분자가 있는 4-4-4-4 형식은 단어 없이 Luhn만으로 가린다", () => {
    assert.deepEqual(scanText(`값 4111 1111 1111 1111 끝`).rules.map((r) => r.id), ["card_number"]);
    assert.deepEqual(scanText(`값 4111-1111-1111-1111 끝`).rules.map((r) => r.id), ["card_number"]);
    assert.deepEqual(scanText(`값 4111 1111 1111 1112 끝`).rules, []);
  });

  it("13자리 바코드(880 시작, EAN-13 검증 자릿수 일치)는 카드 단어가 있어도 가리지 않는다", () => {
    const cardRules = (text) => ids(text).filter((id) => id === "card_number");
    assert.deepEqual(cardRules(`카드 결제 ${luhnAndEan13()}`), []);
    assert.deepEqual(cardRules("결제 8801234567890"), []);
  });
});

describe("합성 비밀 재현율과 코드 식별자 오탐률", () => {
  const SYNTHETIC = Object.entries(POSITIVE)
    .filter(([id]) => !["email", "password_field", "phone_kr"].includes(id))
    .flatMap(([id, samples]) => samples.map((sample) => ({ id, sample })));

  it("합성 비밀 40종 이상을 모두 찾는다", () => {
    assert.ok(SYNTHETIC.length >= 40, `표본 ${SYNTHETIC.length}종`);
    const missed = SYNTHETIC.filter(({ sample }) => scanText(`값: ${sample}`).rules.length === 0);
    assert.deepEqual(missed.map((m) => m.id), []);
  });

  it("코드 식별자 200종에서 오탐이 1% 이하이다", () => {
    const stems   = ["task", "queue", "processor", "worker", "disk", "usage", "monitor", "token", "parser", "handler",
      "bearer", "session", "client", "adapter", "pipeline", "config", "loader", "resolver", "scanner", "builder"];
    const camel   = (list) => list.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
    const corpus  = [];
    for (let i = 0; i < stems.length; i++) {
      const [a, b, c] = [stems[i], stems[(i + 3) % stems.length], stems[(i + 7) % stems.length]];
      corpus.push(camel([a, b, c]), `${a}_${b}_${c}`.toUpperCase(), `${a}-${b}-${c}-${stems[(i + 11) % stems.length]}`,
        `lib/${a}/${b}/${c}Service.js`, `${a[0].toUpperCase()}${a.slice(1)}${b[0].toUpperCase()}${b.slice(1)}Factory`,
        `get${a[0].toUpperCase()}${a.slice(1)}ById(${b}Id, ${c}Options)`, `const ${a}Map = new Map();`,
        `SELECT ${a}_id, ${b}_at FROM ${c}s WHERE ${a}_id = $1`);
    }
    corpus.push("AKIA_ROTATION_POLICY", "ghp_token_regex", "xoxb_client_wrapper", "sk_learn_pipeline", "eyJ_decoder",
      "mmcp_session", "BearerAuthFilter", "BEGIN_PRIVATE_KEY_LOADER", "task-queue-processor-worker-name-long",
      "ASIA_PACIFIC_REGION_CONFIG_TABLE", "password_policy_validator", "passwordResetToken", "emailAddressParser",
      "user@Component", "@Injectable()", "@param {string} name", "v1.2.3-beta.4", "2026-10-03T12:00:00Z",
      "1759468800000", "550e8400-e29b-41d4-a716-446655440000", "a".repeat(40), "0123456789abcdef".repeat(4),
      "sha256:" + "ab12".repeat(16), "node_modules/.bin/eslint", "tests/unit/sensitive-scanner.test.js",
      "http://localhost:57332/mcp", "MEMENTO_SENSITIVE_SCAN=mask", "Authorization header parser",
      "ScannerRuleTable", "redactPrompt(text)", "maskSensitiveText", "keywords.map(normalize)", "tokenBudget=2000",
      "workspace/default", "api-key-policy-editor", "case_events_source_idx", "fragments.content_hash", "isAnchor=true",
      "memento_mcp_sessions", "lib/memory/write/WriteGate.js");
    assert.ok(corpus.length >= 200, `표본 ${corpus.length}종`);

    const flagged = corpus.filter((text) => scanText(text).rules.length > 0);
    assert.ok(flagged.length / corpus.length <= 0.01, `오탐 ${flagged.length}건: ${flagged.slice(0, 5).join(" | ")}`);

    const foldFlagged = corpus.map((text) => text.toLowerCase()).filter((text) => scanText(text, { foldCase: true }).rules.length > 0);
    assert.ok(foldFlagged.length / corpus.length <= 0.01, `키워드 오탐 ${foldFlagged.length}건: ${foldFlagged.slice(0, 5).join(" | ")}`);
  });
});

describe("검증 함수", () => {
  it("luhnValid와 rrnChecksumValid가 알려진 값을 판정한다", () => {
    assert.equal(luhnValid("4111111111111111"), true);
    assert.equal(luhnValid("4111111111111112"), false);
    assert.equal(rrnChecksumValid(rrnDigits("900101123456")), true);
    assert.equal(rrnChecksumValid(`${rrnDigits("900101123456").slice(0, 12)}${(Number(rrnDigits("900101123456")[12]) + 1) % 10}`), false);
  });
});

describe("적대적 입력의 처리 시간", () => {
  const SIZE      = 200_000;
  const LIMIT_MS  = 1500;
  const inputs    = {
    "단일 문자 반복"       : rep("a", SIZE),
    "숫자 반복"            : rep("9", SIZE),
    "공백 반복"            : rep(" ", SIZE),
    "sk- 반복"             : rep("sk-", SIZE / 3),
    "sk-ant- 반복"         : rep("sk-ant-", SIZE / 7),
    "eyJ 반복"             : rep("eyJ", SIZE / 3),
    "eyJ 점 반복"          : rep("eyJaaaaaa.", SIZE / 10),
    "AKIA 반복"            : rep("AKIA", SIZE / 4),
    "ghp_ 반복"            : rep("ghp_", SIZE / 4),
    "xoxb- 반복"           : rep("xoxb-", SIZE / 5),
    "mmcp_ 반복"           : rep("mmcp_", SIZE / 5),
    "PEM 시작 반복"        : rep("-----BEGIN PRIVATE KEY-----", SIZE / 27),
    "PEM 시작 꼬리 없음"   : `-----BEGIN RSA PRIVATE KEY-----${rep("A", SIZE)}`,
    "PEM 머리말 뒤 공백"   : `-----BEGIN PRIVATE KEY-----${rep(" ", SIZE)}`,
    "PEM 본문 뒤 공백"     : `-----BEGIN PRIVATE KEY----- ${rep("A", 40)}${rep(" ", SIZE)}`,
    "PEM 공백 토큰 반복"   : `-----BEGIN PRIVATE KEY----- ${rep(`${rep("A", 16)} `, SIZE / 17)}`,
    "PEM 짧은 토큰 반복"   : `-----BEGIN PRIVATE KEY----- ${rep("A", 40)}${rep(" A", SIZE / 2)}`,
    "PEM 머리말 공백 반복" : rep("-----BEGIN PRIVATE KEY----- ", SIZE / 28),
    "PEM 머리말과 헤더 줄 반복": rep("-----BEGIN PRIVATE KEY-----\nA: b\n", SIZE / 33),
    "PEM 줄 구분자 반복"   : `-----BEGIN PRIVATE KEY-----${rep("\\n" + rep("A", 3), SIZE / 5)}`,
    "PEM 짧은 줄 반복"     : `-----BEGIN PRIVATE KEY-----\n${rep("A", 39)}${rep("\nA", SIZE / 2)}`,
    "카드 숫자 반복 문맥"  : rep("card 4111111111111111 ", SIZE / 22),
    "Bearer 반복"          : rep("Bearer ", SIZE / 7),
    "Bearer 공백"          : `Bearer${rep(" ", SIZE)}`,
    "password 반복"        : rep("password:", SIZE / 9),
    "password 공백"        : `password:${rep(" ", SIZE)}`,
    "골뱅이 반복"          : rep("a@", SIZE / 2),
    "골뱅이 앞 로컬 부분"  : rep("a.", SIZE / 2),
    "골뱅이 뒤 도메인"     : `a@${rep("b.", SIZE / 2)}1`,
    "도메인 꼬리 숫자"     : `a@${rep("b", SIZE)}`,
    "숫자 공백 교대"       : rep("1 ", SIZE / 2),
    "숫자 하이픈 교대"     : rep("1-", SIZE / 2),
    "주민번호 접두 반복"   : rep("900101-", SIZE / 7),
    "카드 군집 반복"       : rep("4111 1111 1111 1111 ", SIZE / 20),
    "전화 접두 반복"       : rep("010-", SIZE / 4),
    "URL 스킴 반복"        : rep("postgres://", SIZE / 11),
    "URL 사용자 콜론 반복" : `postgres://${rep("u:", SIZE / 2)}`,
    "URL 비밀번호 꼬리"    : `postgres://u:${rep("p", SIZE)}`,
    "대입 이름 반복"       : rep("TOKEN=", SIZE / 6),
    "대입 이름 단어 반복"  : rep("a_secret_", SIZE / 9),
    "대입 값 꼬리"         : `API_KEY=${rep("x", SIZE)}`,
    "AWS 비밀 이름 반복"   : rep("aws_secret_access_key=", SIZE / 22)
  };

  for (const [name, text] of Object.entries(inputs)) {
    for (const [label, options] of [["일반", {}], ["대소문자 무시", { foldCase: true }]]) {
      it(`${name} (${label}): ${LIMIT_MS}ms 이내`, () => {
        const started = performance.now();
        scanText(text, options);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < LIMIT_MS, `${elapsed.toFixed(0)}ms`);
      });
    }
  }
});
